package images

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const (
	maxHeadBytes     = 1 << 20
	headTimeout      = 10 * time.Second
	maxDownloadBytes = 64 << 20
	downloadTimeout  = 60 * time.Second
	maxRedirects     = 2
)

// Resolver resolves host names for the controlled image fetcher.
type Resolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

// Dialer opens the TCP connection to an already validated address.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

// RemoteOptions injects network boundaries for tests. Production leaves the
// dialer, resolver and transport nil so the secure defaults apply.
type RemoteOptions struct {
	Resolver  Resolver
	Dialer    Dialer
	Transport http.RoundTripper
}

// Remote performs SSRF-safe reference reads and output downloads.
type Remote struct {
	client   *http.Client
	resolver Resolver
}

// NewRemote builds the controlled fetcher.
func NewRemote(options RemoteOptions) *Remote {
	resolver := options.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	dialer := options.Dialer
	if dialer == nil {
		dialer = &net.Dialer{Timeout: 30 * time.Second}
	}

	remote := &Remote{resolver: resolver}
	transport := options.Transport
	if transport == nil {
		transport = &http.Transport{
			Proxy: nil, // never let environment proxies bypass address checks
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				return remote.secureDial(ctx, network, address, dialer)
			},
			TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
			ForceAttemptHTTP2: true,
		}
	}
	remote.client = &http.Client{Transport: transport, CheckRedirect: remote.checkRedirect}
	return remote
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
	if err := r.validateURL(ctx, parsed, true); err != nil {
		return domain.PixelSize{}, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return domain.PixelSize{}, err
	}
	response, err := r.do(request, true)
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

// Download fetches an output image for archiving. Only HTTPS is allowed and
// only png/jpeg/webp bytes are returned.
func (r *Remote) Download(ctx context.Context, source string) ([]byte, string, error) {
	parsed, err := url.Parse(source)
	if err != nil || parsed.Host == "" {
		return nil, "", fmt.Errorf("unsupported image URL")
	}
	if parsed.Scheme != "https" {
		return nil, "", fmt.Errorf("output images must be fetched over https")
	}

	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	if err := r.validateURL(ctx, parsed, false); err != nil {
		return nil, "", err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, "", err
	}
	response, err := r.do(request, false)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, "", fmt.Errorf("image download returned status %d", response.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, maxDownloadBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > maxDownloadBytes {
		return nil, "", fmt.Errorf("image download exceeds %d bytes", maxDownloadBytes)
	}
	mime := SniffImage(data)
	if mime == "" {
		return nil, "", fmt.Errorf("downloaded content is not png, jpeg or webp")
	}
	return data, mime, nil
}

type allowHTTPKey struct{}

func (r *Remote) do(request *http.Request, allowHTTP bool) (*http.Response, error) {
	ctx := context.WithValue(request.Context(), allowHTTPKey{}, allowHTTP)
	return r.client.Do(request.WithContext(ctx))
}

func (r *Remote) checkRedirect(request *http.Request, via []*http.Request) error {
	if len(via) > maxRedirects {
		return fmt.Errorf("too many redirects")
	}
	allowHTTP, _ := request.Context().Value(allowHTTPKey{}).(bool)
	return r.validateURL(request.Context(), request.URL, allowHTTP)
}

func (r *Remote) validateURL(ctx context.Context, parsed *url.URL, allowHTTP bool) error {
	if parsed.Hostname() == "" || parsed.User != nil {
		return fmt.Errorf("unsupported image URL")
	}
	if parsed.Scheme != "https" && !(allowHTTP && parsed.Scheme == "http") {
		return fmt.Errorf("unsupported image URL scheme")
	}
	addresses, err := r.resolver.LookupIPAddr(ctx, parsed.Hostname())
	if err != nil {
		return fmt.Errorf("image host could not be resolved")
	}
	for _, address := range addresses {
		if isPublicIP(address.IP) {
			return nil
		}
	}
	return fmt.Errorf("image host is not publicly routable")
}

func (r *Remote) secureDial(ctx context.Context, network, address string, dialer Dialer) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := r.resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("image host could not be resolved")
	}
	var lastErr error
	for _, candidate := range addresses {
		if !isPublicIP(candidate.IP) {
			continue
		}
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.IP.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("image host is not publicly routable")
}

var reservedNetworks = mustCIDRs(
	"0.0.0.0/8",
	"100.64.0.0/10",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.88.99.0/24",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"240.0.0.0/4",
	"255.255.255.255/32",
	"100::/64",
	"2001:db8::/32",
	"2002::/16",
)

func mustCIDRs(values ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, network, err := net.ParseCIDR(value)
		if err != nil {
			panic(err)
		}
		out = append(out, network)
	}
	return out
}

func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
		return false
	}
	for _, network := range reservedNetworks {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}
