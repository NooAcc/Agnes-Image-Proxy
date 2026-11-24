package agnes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxResponseBytes = 128 << 20

// Generator issues one upstream generation request.
type Generator interface {
	Generate(ctx context.Context, baseURL, key string, payload map[string]any, timeout time.Duration) (json.RawMessage, error)
}

// HTTPError is a non-2xx upstream response.
type HTTPError struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("upstream status %d: %s", e.Status, e.Message)
}

// HTTPStatus exposes the upstream status for failure aggregation.
func (e *HTTPError) HTTPStatus() int { return e.Status }

// Client talks to the Agnes generation endpoint.
type Client struct {
	client *http.Client
}

// NewClient wraps an HTTP client. Redirects never carry the bearer token to a
// different origin.
func NewClient(httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	clone := *httpClient
	clone.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if len(via) > 0 && req.URL.Host != via[0].URL.Host {
			req.Header.Del("Authorization")
		}
		return nil
	}
	return &Client{client: &clone}
}

// Generate posts one generation request with a per-attempt timeout.
func (c *Client) Generate(ctx context.Context, baseURL, key string, payload map[string]any, timeout time.Duration) (json.RawMessage, error) {
	if timeout <= 0 {
		timeout = 300 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	endpoint := strings.TrimRight(baseURL, "/") + "/images/generations"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+key)

	response, err := c.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		code, message := upstreamError(data, key)
		return nil, &HTTPError{
			Status:     response.StatusCode,
			Code:       code,
			Message:    message,
			RetryAfter: parseRetryAfter(response.Header.Get("Retry-After"), time.Now()),
		}
	}
	return data, nil
}

// ProbeModels checks account availability through the models catalog, which
// never consumes image quota.
func (c *Client) ProbeModels(ctx context.Context, baseURL, key string, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	endpoint := strings.TrimRight(baseURL, "/") + "/models"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+key)

	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		code, message := upstreamError(data, key)
		return &HTTPError{
			Status:     response.StatusCode,
			Code:       code,
			Message:    message,
			RetryAfter: parseRetryAfter(response.Header.Get("Retry-After"), time.Now()),
		}
	}
	return nil
}

func upstreamError(data []byte, key string) (string, string) {
	var envelope struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &envelope)
	message := strings.TrimSpace(envelope.Error.Message)
	code := strings.TrimSpace(envelope.Error.Code)
	if message == "" {
		message = "upstream request failed"
	}
	if key != "" {
		message = strings.ReplaceAll(message, key, "[redacted]")
	}
	if len(message) > 300 {
		message = message[:300]
	}
	if len(code) > 100 {
		code = code[:100]
	}
	return code, message
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	const (
		fallback = 60 * time.Second
		maxDelay = 900 * time.Second
	)
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds < 0 {
			return fallback
		}
		delay := time.Duration(seconds) * time.Second
		if delay > maxDelay {
			return maxDelay
		}
		return delay
	}
	if parsed, err := http.ParseTime(value); err == nil {
		delay := parsed.Sub(now)
		if delay <= 0 {
			return fallback
		}
		if delay > maxDelay {
			return maxDelay
		}
		return delay
	}
	return fallback
}
