package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const (
	edgeBatchItems           = 20
	measureTimeout           = 10 * time.Second
	enrichBatchSourceBytes   = 32 << 20
	maxEnrichSourceBytes     = 50 << 20
	enrichmentErrorMaxLength = 200
	maxEdgeResponseBytes     = 64 << 20
)

// EnrichmentWriter persists enrichment outcomes for gallery rows.
type EnrichmentWriter interface {
	SetEnrichment(ctx context.Context, id int64, write domain.EnrichmentWrite) error
}

// EnrichReport summarises one enrichment pass.
type EnrichReport struct {
	Processed int
	Succeeded int
	Failed    int
}

// Edge is the shared Edge-Images client for metadata and enrichment.
type Edge struct {
	client *http.Client
	writer EnrichmentWriter
	now    func() time.Time
}

// NewEdge builds the client. A nil client uses http.DefaultClient semantics.
func NewEdge(client *http.Client) *Edge {
	if client == nil {
		client = &http.Client{}
	}
	return &Edge{client: client, now: time.Now}
}

// WithEnrichmentWriter attaches the persistence boundary used by Enrich.
func (e *Edge) WithEnrichmentWriter(writer EnrichmentWriter) *Edge {
	e.writer = writer
	return e
}

type batchItem struct {
	UUID        string         `json:"uuid"`
	URL         string         `json:"url,omitempty"`
	Base64      string         `json:"base64,omitempty"`
	ContentType string         `json:"contentType,omitempty"`
	Params      map[string]any `json:"params"`
}

type batchResult struct {
	Success bool            `json:"success"`
	Status  string          `json:"status"`
	Error   string          `json:"error"`
	Data    json.RawMessage `json:"data"`
}

func (r batchResult) ok() bool {
	return r.Success || r.Status == "ok"
}

func (e *Edge) postBatch(ctx context.Context, baseURL string, timeout time.Duration, items []batchItem) (map[string]batchResult, error) {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	payload, err := json.Marshal(items)
	if err != nil {
		return nil, err
	}
	endpoint := strings.TrimRight(baseURL, "/") + "/api/batch"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := e.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("image service responded %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxEdgeResponseBytes))
	if err != nil {
		return nil, err
	}
	var results map[string]batchResult
	if err := json.Unmarshal(data, &results); err != nil || results == nil {
		return nil, fmt.Errorf("image service returned an invalid response")
	}
	return results, nil
}

func truncateError(message string) string {
	if len(message) > enrichmentErrorMaxLength {
		return message[:enrichmentErrorMaxLength]
	}
	return message
}

func timeDurationMS(ms int) time.Duration {
	if ms <= 0 {
		return 60 * time.Second
	}
	return time.Duration(ms) * time.Millisecond
}

func sourceHasURL(source domain.GallerySource) bool {
	return source.SourceURL != nil && strings.TrimSpace(*source.SourceURL) != ""
}
