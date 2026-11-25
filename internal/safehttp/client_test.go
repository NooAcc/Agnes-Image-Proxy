package safehttp_test

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/safehttp"
)

type staticResolver struct{ ips []net.IPAddr }

func (s staticResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return s.ips, nil
}

type seqResolver struct {
	mu    sync.Mutex
	pages [][]net.IPAddr
}

func (s *seqResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pages) == 0 {
		return nil, fmt.Errorf("resolver exhausted")
	}
	page := s.pages[0]
	if len(s.pages) > 1 {
		s.pages = s.pages[1:]
	}
	return page, nil
}

type funcDialer func(ctx context.Context, network, address string) (net.Conn, error)

func (f funcDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return f(ctx, network, address)
}

func publicResolver() staticResolver {
	return staticResolver{ips: []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}}
}

func TestSafeHTTPRejectsReservedDNSAndRebinding(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "0.0.0.0"} {
		t.Run(ip, func(t *testing.T) {
			dialed := false
			client := safehttp.New(safehttp.Options{
				Resolver: staticResolver{ips: []net.IPAddr{{IP: net.ParseIP(ip)}}},
				Dialer: funcDialer(func(context.Context, string, string) (net.Conn, error) {
					dialed = true
					return nil, fmt.Errorf("should not dial")
				}),
			})
			req, _ := http.NewRequest(http.MethodGet, "https://images.example/a.png", nil)
			if _, err := client.Do(req, safehttp.Policy{}); err == nil {
				t.Fatal("reserved address accepted")
			}
			if dialed {
				t.Fatal("dialer called for reserved address")
			}
		})
	}

	dialed := false
	client := safehttp.New(safehttp.Options{
		Resolver: &seqResolver{pages: [][]net.IPAddr{
			{{IP: net.ParseIP("93.184.216.34")}},
			{{IP: net.ParseIP("10.0.0.5")}},
		}},
		Dialer: funcDialer(func(context.Context, string, string) (net.Conn, error) {
			dialed = true
			return nil, fmt.Errorf("should not dial")
		}),
	})
	req, _ := http.NewRequest(http.MethodGet, "https://images.example/a.png", nil)
	if _, err := client.Do(req, safehttp.Policy{}); err == nil {
		t.Fatal("DNS rebinding accepted")
	}
	if dialed {
		t.Fatal("dialer called after rebinding to a private address")
	}
}

type redirectTransport struct {
	mu       sync.Mutex
	requests []string
	target   string
}

func (t *redirectTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.requests = append(t.requests, req.URL.String())
	t.mu.Unlock()
	return &http.Response{
		StatusCode: http.StatusFound,
		Header:     http.Header{"Location": {t.target}},
		Body:       io.NopCloser(strings.NewReader("")),
		Request:    req,
	}, nil
}

func TestSafeHTTPRedirectPolicies(t *testing.T) {
	target := "https://redirect.example/next"

	noRedirect := &redirectTransport{target: target}
	client := safehttp.New(safehttp.Options{Resolver: publicResolver(), Transport: noRedirect})
	req, _ := http.NewRequest(http.MethodPost, "https://images.example/upload", strings.NewReader("body"))
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := client.Do(req, safehttp.Policy{MaxRedirects: 0})
	if err != nil {
		t.Fatalf("zero redirect policy should return the 3xx: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	if len(noRedirect.requests) != 1 {
		t.Fatalf("redirect target received requests: %v", noRedirect.requests)
	}

	limited := &redirectTransport{target: target}
	client = safehttp.New(safehttp.Options{Resolver: publicResolver(), Transport: limited})
	req, _ = http.NewRequest(http.MethodGet, "https://images.example/a.png", nil)
	if _, err := client.Do(req, safehttp.Policy{MaxRedirects: 2}); err == nil {
		t.Fatal("third redirect was followed")
	}
	if len(limited.requests) != 3 {
		t.Fatalf("requests = %d, want initial + 2 redirects", len(limited.requests))
	}

	reserved := &redirectTransport{target: "https://reserved.example/next"}
	client = safehttp.New(safehttp.Options{
		Resolver: &seqResolver{pages: [][]net.IPAddr{
			{{IP: net.ParseIP("93.184.216.34")}},
			{{IP: net.ParseIP("10.0.0.1")}},
		}},
		Transport: reserved,
	})
	req, _ = http.NewRequest(http.MethodGet, "https://images.example/a.png", nil)
	if _, err := client.Do(req, safehttp.Policy{MaxRedirects: 2}); err == nil {
		t.Fatal("redirect to a reserved address was followed")
	}
	if len(reserved.requests) != 1 {
		t.Fatalf("reserved redirect target received a request: %v", reserved.requests)
	}

	client = safehttp.New(safehttp.Options{Resolver: publicResolver(), Transport: okTransport{}})
	req, _ = http.NewRequest(http.MethodGet, "http://images.example/a.png", nil)
	if _, err := client.Do(req, safehttp.Policy{}); err == nil {
		t.Fatal("http accepted without AllowHTTP")
	}
	resp, err = client.Do(req, safehttp.Policy{AllowHTTP: true, MaxRedirects: 0})
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("explicit AllowHTTP = %v, %v", resp, err)
	}
	_ = resp.Body.Close()
}

type okTransport struct{}

func (okTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
}

func TestSafeHTTPIgnoresEnvironmentProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9")
	dialed := make(chan string, 1)
	client := safehttp.New(safehttp.Options{
		Resolver: publicResolver(),
		Dialer: funcDialer(func(_ context.Context, _, address string) (net.Conn, error) {
			dialed <- address
			return nil, fmt.Errorf("stop after recording")
		}),
	})
	req, _ := http.NewRequest(http.MethodGet, "https://images.example/a.png", nil)
	if _, err := client.Do(req, safehttp.Policy{}); err == nil {
		t.Fatal("expected the injected dialer to abort the request")
	}
	select {
	case address := <-dialed:
		if address != "93.184.216.34:443" {
			t.Fatalf("dialed %q, environment proxy was honored", address)
		}
	default:
		t.Fatal("dialer was not called")
	}
}
