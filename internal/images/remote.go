package images

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/safehttp"
)

const (
	maxHeadBytes     = 1 << 20
	headTimeout      = 10 * time.Second
	maxDownloadBytes = 64 << 20
	downloadTimeout  = 60 * time.Second
	maxRedirects     = 2
)

// RemoteOptions injects network boundaries for tests. Production leaves the
// dialer, resolver and transport nil so the secure defaults apply.
type RemoteOptions struct {
	Resolver  safehttp.Resolver
	Dialer    safehttp.Dialer
	Transport http.RoundTripper
}

// Remote performs SSRF-safe reference reads and output downloads.
type Remote struct {
	client *safehttp.Client
}

// NewRemote builds the controlled fetcher.
func NewRemote(options RemoteOptions) *Remote {
	return &Remote{client: safehttp.New(safehttp.Options{
		Resolver:  options.Resolver,
		Dialer:    options.Dialer,
		Transport: options.Transport,
	})}
}

// Dimensions reads a reference image's pixel size without full decoding.
// HTTP is allowed for reference reads; redirects are re-validated.
func (r *Remote) Dimensions(ctx context.Context, source string) (domain.PixelSize, error) {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(source)), "data:") {
		_, data, err := decodeDataURI(strings.TrimSpace(source))
		if err != nil {
			return domain.PixelSize{}, err
		}
		return ImageDimensions(data)
	}

	parsed, err := url.Parse(source)
	if err != nil || parsed.Host == "" {
		return domain.PixelSize{}, fmt.Errorf("unsupported image URL")
	}

	ctx, cancel := context.WithTimeout(ctx, headTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return domain.PixelSize{}, err
	}
	response, err := r.client.Do(request, safehttp.Policy{AllowHTTP: true, MaxRedirects: maxRedirects})
	if err != nil {
		return domain.PixelSize{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return domain.PixelSize{}, fmt.Errorf("reference image returned status %d", response.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, maxHeadBytes+1))
	if err != nil {
		return domain.PixelSize{}, err
	}
	if len(data) > maxHeadBytes {
		return domain.PixelSize{}, fmt.Errorf("reference image header exceeds %d bytes", maxHeadBytes)
	}
	if SniffImage(data) == "" {
		return domain.PixelSize{}, fmt.Errorf("reference image is not png, jpeg or webp")
	}
	return ImageDimensions(data)
}

// DownloadError classifies retry policy without exposing a source URL to clients.
type DownloadError struct {
	Status    int
	Retryable bool
	Err       error
}

func (e *DownloadError) Error() string { return "image download failed" }
func (e *DownloadError) Unwrap() error { return e.Err }
func downloadError(err error, status int, retryable bool) error {
	return &DownloadError{Status: status, Retryable: retryable, Err: err}
}
func networkDownloadError(err error) error {
	var classified *DownloadError
	if errors.As(err, &classified) {
		return classified
	}
	var network net.Error
	return downloadError(err, 0, errors.As(err, &network) && (network.Timeout() || network.Temporary()))
}

// Download fetches an output original under the existing SSRF and size boundaries.
func (r *Remote) Download(ctx context.Context, source string) ([]byte, string, error) {
	parsed, err := url.Parse(source)
	if err != nil || parsed.Host == "" || parsed.Scheme != "https" {
		return nil, "", downloadError(fmt.Errorf("unsupported image URL"), 0, false)
	}
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, "", downloadError(err, 0, false)
	}
	response, err := r.client.Do(request, safehttp.Policy{AllowHTTP: false, MaxRedirects: maxRedirects})
	if err != nil {
		return nil, "", networkDownloadError(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, "", downloadError(fmt.Errorf("image download returned status %d", response.StatusCode), response.StatusCode, response.StatusCode == 429 || response.StatusCode >= 500)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxDownloadBytes+1))
	if err != nil {
		return nil, "", networkDownloadError(err)
	}
	if len(data) > maxDownloadBytes {
		return nil, "", downloadError(fmt.Errorf("image download exceeds limit"), 0, false)
	}
	mime := SniffImage(data)
	if mime == "" {
		return nil, "", downloadError(fmt.Errorf("downloaded content is not png, jpeg or webp"), 0, false)
	}
	return data, mime, nil
}
