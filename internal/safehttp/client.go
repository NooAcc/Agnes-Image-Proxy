// Package safehttp provides the shared outbound HTTP boundary: HTTPS-only
// URLs by default, public-address-only DNS/dialing, no environment proxy, and
// explicit redirect limits. Credentials never cross a redirect that the caller
// did not allow.
package safehttp

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"
)

// Resolver resolves host names for the controlled fetcher.
type Resolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

// Dialer opens the TCP connection to an already validated address.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

// Options injects network boundaries for tests. Production leaves every field
// nil so the secure defaults apply.
type Options struct {
	Resolver  Resolver
	Dialer    Dialer
	Transport http.RoundTripper
}

// Policy controls one request. MaxRedirects=0 disables redirect following and
// returns the 3xx response for the caller to reject.
type Policy struct {
	AllowHTTP    bool
	MaxRedirects int
}

type policyKey struct{}

// Client performs controlled outbound requests.
type Client struct {
	client   *http.Client
	resolver Resolver
}

// New builds the controlled client.
func New(options Options) *Client {
	resolver := options.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	dialer := options.Dialer
	if dialer == nil {
		dialer = &net.Dialer{Timeout: 30 * time.Second}
	}

	client := &Client{resolver: resolver}
	transport := options.Transport
	if transport == nil {
		transport = &http.Transport{
			Proxy: nil, // never let environment proxies bypass address checks
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				return client.secureDial(ctx, network, address, dialer)
			},
			TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
			ForceAttemptHTTP2: true,
		}
	}
	client.client = &http.Client{Transport: transport, CheckRedirect: client.checkRedirect}
	return client
}

// Do preflights the destination and executes the request under policy.
func (c *Client) Do(req *http.Request, policy Policy) (*http.Response, error) {
	ctx := context.WithValue(req.Context(), policyKey{}, policy)
	if err := c.validateURL(ctx, req.URL, policy.AllowHTTP); err != nil {
		return nil, err
	}
	return c.client.Do(req.WithContext(ctx))
}

func policyFrom(ctx context.Context) Policy {
	policy, _ := ctx.Value(policyKey{}).(Policy)
	return policy
}

func (c *Client) checkRedirect(request *http.Request, via []*http.Request) error {
	policy := policyFrom(request.Context())
	if policy.MaxRedirects <= 0 {
		return http.ErrUseLastResponse
	}
	if len(via) > policy.MaxRedirects {
		return fmt.Errorf("too many redirects")
	}
	return c.validateURL(request.Context(), request.URL, policy.AllowHTTP)
}

func (c *Client) validateURL(ctx context.Context, parsed *url.URL, allowHTTP bool) error {
	if parsed == nil || parsed.Hostname() == "" || parsed.User != nil {
		return fmt.Errorf("unsupported URL")
	}
	if parsed.Scheme != "https" && !(allowHTTP && parsed.Scheme == "http") {
		return fmt.Errorf("unsupported URL scheme")
	}
	addresses, err := c.resolver.LookupIPAddr(ctx, parsed.Hostname())
	if err != nil {
		return fmt.Errorf("host could not be resolved: %w", err)
	}
	for _, address := range addresses {
		if IsPublicIP(address.IP) {
			return nil
		}
	}
	return fmt.Errorf("host is not publicly routable")
}

func (c *Client) secureDial(ctx context.Context, network, address string, dialer Dialer) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := c.resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("host could not be resolved: %w", err)
	}
	var lastErr error
	for _, candidate := range addresses {
		if !IsPublicIP(candidate.IP) {
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
	return nil, fmt.Errorf("host is not publicly routable")
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

// IsPublicIP reports whether ip is a globally routable unicast address.
func IsPublicIP(ip net.IP) bool {
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
