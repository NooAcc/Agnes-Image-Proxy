// Package imgbed implements the CloudFlare ImgBed HTTP contract used as the
// original-image backend: fixed upload parameters, verified read-back, HEAD
// existence checks and single-file deletion.
package imgbed

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/safehttp"
)

const (
	maxOriginalBytes   = 64 << 20
	maxUploadResponse  = 1 << 20
	uploadBudget       = 60 * time.Second
	readBudget         = 60 * time.Second
	headBudget         = 10 * time.Second
	deleteBudget       = 30 * time.Second
	cleanupBudget      = 5 * time.Second
	maxRedirectsPublic = 2
)

// ErrNotFound marks a remote file that genuinely does not exist. Permission
// and transport failures never map to this sentinel.
var ErrNotFound = errors.New("imgbed file not found")

// Object identifies one verified original without carrying the site address.
type Object struct {
	Ref   string
	MIME  string
	Bytes int64
}

// Options injects the HTTP boundary and clock.
type Options struct {
	HTTP safehttp.Options
	Now  func() time.Time
}

// Client is a configured ImgBed site.
type Client struct {
	baseURL string
	token   string
	http    *safehttp.Client
	now     func() time.Time
}

// New validates the storage snapshot and builds a client.
func New(cfg domain.StorageConfig, opts Options) (*Client, error) {
	if cfg.Mode != domain.StorageImgbed {
		return nil, errors.New("imgbed client requires imgbed storage")
	}
	baseURL, err := domain.NormalizeImgbedBaseURL(cfg.ImgbedBaseURL)
	if err != nil {
		return nil, err
	}
	token, err := domain.ValidateImgbedToken(cfg.ImgbedToken)
	if err != nil {
		return nil, err
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    safehttp.New(opts.HTTP),
		now:     now,
	}, nil
}

// Error reports only the operation and status. It never contains the site,
// token, source URL or remote response body.
type Error struct {
	Op     string
	Status int
	Err    error
}

func (e *Error) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("imgbed %s failed with status %d", e.Op, e.Status)
	}
	return "imgbed " + e.Op + " failed"
}

func (e *Error) Unwrap() error { return e.Err }

func operationError(op string, status int, err error) error {
	return &Error{Op: op, Status: status, Err: err}
}

// Upload stores one original and verifies the read-back byte-for-byte. The
// returned bytes are exactly the verified remote content.
func (c *Client) Upload(ctx context.Context, publicID, mime string, data []byte) (Object, []byte, error) {
	ext, ok := imageExtension(mime)
	if !ok || len(data) == 0 || len(data) > maxOriginalBytes || !validPublicID(publicID) {
		return Object{}, nil, errors.New("invalid upload original")
	}
	folder := uploadFolder(c.now())

	ctx, cancel := context.WithTimeout(ctx, uploadBudget)
	defer cancel()

	request, err := c.uploadRequest(ctx, publicID+"."+ext, mime, data, folder)
	if err != nil {
		return Object{}, nil, err
	}
	response, err := c.http.Do(request, safehttp.Policy{AllowHTTP: false, MaxRedirects: 0})
	if err != nil {
		return Object{}, nil, operationError("upload", 0, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return Object{}, nil, operationError("upload", response.StatusCode, nil)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxUploadResponse+1))
	if err != nil {
		return Object{}, nil, operationError("upload", response.StatusCode, err)
	}
	if len(body) > maxUploadResponse {
		return Object{}, nil, operationError("upload", response.StatusCode, errors.New("upload response is too large"))
	}
	ref, err := parseUploadResponse(body, c.baseURL, folder)
	if err != nil {
		return Object{}, nil, operationError("upload", response.StatusCode, err)
	}

	object := Object{Ref: ref, MIME: mime, Bytes: int64(len(data))}
	verified, err := c.Read(ctx, object)
	if err != nil {
		c.cleanupCandidate(ref)
		return Object{}, nil, err
	}
	if !bytes.Equal(verified, data) {
		c.cleanupCandidate(ref)
		return Object{}, nil, errors.New("uploaded original does not match read-back")
	}
	return object, verified, nil
}

func (c *Client) uploadRequest(ctx context.Context, filename, mime string, data []byte, folder string) (*http.Request, error) {
	boundary, err := randomBoundary()
	if err != nil {
		return nil, err
	}
	header := fmt.Sprintf("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\nContent-Type: %s\r\n\r\n",
		boundary, filename, mime)
	footer := "\r\n--" + boundary + "--\r\n"
	query := url.Values{
		"serverCompress": {"false"},
		"returnFormat":   {"full"},
		"uploadFolder":   {folder},
	}
	target := c.baseURL + "/upload?" + query.Encode()
	body := io.MultiReader(strings.NewReader(header), bytes.NewReader(data), strings.NewReader(footer))
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, body)
	if err != nil {
		return nil, err
	}
	request.ContentLength = int64(len(header) + len(data) + len(footer))
	request.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	request.Header.Set("Authorization", "Bearer "+c.token)
	return request, nil
}

type uploadItem struct {
	Src       string          `json:"src"`
	ExpiresAt json.RawMessage `json:"expiresAt"`
}

func parseUploadResponse(body []byte, baseURL, folder string) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	var items []uploadItem
	if err := decoder.Decode(&items); err != nil {
		return "", errors.New("upload response is not a JSON array")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return "", errors.New("upload response has trailing content")
	}
	if len(items) != 1 || strings.TrimSpace(items[0].Src) == "" {
		return "", errors.New("upload response must contain exactly one file")
	}
	if len(items[0].ExpiresAt) > 0 && !bytes.Equal(bytes.TrimSpace(items[0].ExpiresAt), []byte("null")) {
		return "", errors.New("upload returned a file with an expiry")
	}
	return parseUploadSource(items[0].Src, baseURL, folder)
}

// Read fetches and validates one original without sending the API token.
func (c *Client) Read(ctx context.Context, object Object) ([]byte, error) {
	target, err := fileURL(c.baseURL, "file", object.Ref)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, readBudget)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	response, err := c.http.Do(request, safehttp.Policy{AllowHTTP: false, MaxRedirects: maxRedirectsPublic})
	if err != nil {
		return nil, operationError("read", 0, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, operationError("read", response.StatusCode, nil)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxOriginalBytes+1))
	if err != nil {
		return nil, operationError("read", response.StatusCode, err)
	}
	if len(data) > maxOriginalBytes {
		return nil, operationError("read", response.StatusCode, errors.New("original exceeds limit"))
	}
	sniffed := images.SniffImage(data)
	if sniffed == "" || normalizeMIME(sniffed) != normalizeMIME(object.MIME) {
		return nil, operationError("read", response.StatusCode, errors.New("original MIME mismatch"))
	}
	if object.Bytes > 0 && int64(len(data)) != object.Bytes {
		return nil, operationError("read", response.StatusCode, errors.New("original length mismatch"))
	}
	return data, nil
}

// Head verifies existence and metadata without downloading the body.
func (c *Client) Head(ctx context.Context, object Object) error {
	target, err := fileURL(c.baseURL, "file", object.Ref)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, headBudget)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, target, nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request, safehttp.Policy{AllowHTTP: false, MaxRedirects: maxRedirectsPublic})
	if err != nil {
		return operationError("head", 0, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return operationError("head", response.StatusCode, nil)
	}
	if response.ContentLength >= 0 && object.Bytes > 0 && response.ContentLength != object.Bytes {
		return operationError("head", response.StatusCode, errors.New("original length mismatch"))
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "" && normalizeMIME(contentType) != normalizeMIME(object.MIME) {
		return operationError("head", response.StatusCode, errors.New("original MIME mismatch"))
	}
	return nil
}

// Delete removes exactly one registered file. HTTP 200 with success=false is a
// failure; existed=false is an idempotent success.
func (c *Client) Delete(ctx context.Context, ref string) error {
	target, err := fileURL(c.baseURL, "api/manage/delete", ref)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, deleteBudget)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	response, err := c.http.Do(request, safehttp.Policy{AllowHTTP: false, MaxRedirects: 0})
	if err != nil {
		return operationError("delete", 0, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return operationError("delete", response.StatusCode, nil)
	}
	var payload struct {
		Success bool `json:"success"`
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxUploadResponse+1))
	if err != nil {
		return operationError("delete", response.StatusCode, err)
	}
	if err := json.Unmarshal(body, &payload); err != nil || !payload.Success {
		return operationError("delete", response.StatusCode, errors.New("remote delete was not successful"))
	}
	return nil
}

func (c *Client) cleanupCandidate(ref string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), cleanupBudget)
	defer cancel()
	_ = c.Delete(ctx, ref)
}

func randomBoundary() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "imgbed-" + hex.EncodeToString(raw[:]), nil
}

func imageExtension(mime string) (string, bool) {
	switch normalizeMIME(mime) {
	case "image/png":
		return "png", true
	case "image/jpeg":
		return "jpg", true
	case "image/webp":
		return "webp", true
	}
	return "", false
}

func normalizeMIME(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
	if value == "image/jpg" {
		return "image/jpeg"
	}
	return value
}

func validPublicID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for i := 0; i < len(id); i++ {
		if !(id[i] >= '0' && id[i] <= '9' || id[i] >= 'a' && id[i] <= 'f') {
			return false
		}
	}
	return true
}
