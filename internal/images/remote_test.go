package images_test

import (
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

type staticResolver struct {
	ips   []net.IPAddr
	err   error
	calls int
}

func (s *staticResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
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

func publicIP() net.IP { return net.ParseIP("93.184.216.34") }

func publicResolver() *staticResolver {
	return &staticResolver{ips: []net.IPAddr{{IP: publicIP()}}}
}

func dataURI(mime string, data []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func TestRemoteDimensionsFromDataURI(t *testing.T) {
	remote := images.NewRemote(images.RemoteOptions{})
	cases := []struct {
		name string
		uri  string
		w, h int
	}{
		{"png", dataURI("image/png", testutil.PNG(t, 3, 4)), 3, 4},
		{"jpeg", dataURI("image/jpeg", testutil.JPEG(t, 5, 6)), 5, 6},
		{"webp", dataURI("image/webp", testutil.WebP(7, 8)), 7, 8},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := remote.Dimensions(context.Background(), tc.uri)
			if err != nil {
				t.Fatalf("dimensions: %v", err)
			}
			if got.Width != tc.w || got.Height != tc.h {
				t.Fatalf("dims = %+v", got)
			}
		})
	}

	if _, err := remote.Dimensions(context.Background(), "data:image/png;base64,@@@@"); err == nil {
		t.Fatal("malformed data uri accepted")
	}
}

func TestRemoteDimensionsFetchUsesValidatedDial(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(testutil.PNG(t, 9, 10))
	}))
	defer server.Close()

	var mu sync.Mutex
	var dialed []string
	dialer := funcDialer(func(ctx context.Context, network, address string) (net.Conn, error) {
		mu.Lock()
		dialed = append(dialed, address)
		mu.Unlock()
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	remote := images.NewRemote(images.RemoteOptions{Resolver: publicResolver(), Dialer: dialer})

	got, err := remote.Dimensions(context.Background(), "http://images.example/a.png")
	if err != nil {
		t.Fatalf("dimensions: %v", err)
	}
	if got.Width != 9 || got.Height != 10 {
		t.Fatalf("dims = %+v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(dialed) == 0 || dialed[0] != "93.184.216.34:80" {
		t.Fatalf("dialed = %v", dialed)
	}
}

func TestRemoteRejectsPrivateAddress(t *testing.T) {
	resolver := &staticResolver{ips: []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}}
	called := false
	dialer := funcDialer(func(context.Context, string, string) (net.Conn, error) {
		called = true
		return nil, fmt.Errorf("should not dial")
	})
	remote := images.NewRemote(images.RemoteOptions{Resolver: resolver, Dialer: dialer})
	if _, err := remote.Dimensions(context.Background(), "http://localhost/a.png"); err == nil {
		t.Fatal("private address accepted")
	}
	if called {
		t.Fatal("dialer called for private address")
	}
}

func TestRemoteRejectsDNSRebinding(t *testing.T) {
	resolver := &seqResolver{pages: [][]net.IPAddr{
		{{IP: publicIP()}},
		{{IP: net.ParseIP("10.0.0.5")}},
	}}
	called := false
	dialer := funcDialer(func(context.Context, string, string) (net.Conn, error) {
		called = true
		return nil, fmt.Errorf("should not dial")
	})
	remote := images.NewRemote(images.RemoteOptions{Resolver: resolver, Dialer: dialer})
	if _, err := remote.Dimensions(context.Background(), "http://images.example/a.png"); err == nil {
		t.Fatal("rebinding accepted")
	}
	if called {
		t.Fatal("dialer called after rebinding to private address")
	}
}

type hostResolver map[string]net.IP

func (h hostResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	if ip, ok := h[host]; ok {
		return []net.IPAddr{{IP: ip}}, nil
	}
	return []net.IPAddr{{IP: publicIP()}}, nil
}

func TestRemoteRejectsRedirectToPrivate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://127.0.0.1:9/secret.png", http.StatusFound)
	}))
	defer server.Close()

	dialer := funcDialer(func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	remote := images.NewRemote(images.RemoteOptions{
		Resolver: hostResolver{"127.0.0.1": net.ParseIP("127.0.0.1")},
		Dialer:   dialer,
	})
	if _, err := remote.Dimensions(context.Background(), "http://images.example/a.png"); err == nil {
		t.Fatal("redirect to private address accepted")
	}
}

func TestRemoteLimitsRedirects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/next", http.StatusFound)
	}))
	defer server.Close()

	dialer := funcDialer(func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	remote := images.NewRemote(images.RemoteOptions{Resolver: publicResolver(), Dialer: dialer})
	if _, err := remote.Dimensions(context.Background(), "http://images.example/a.png"); err == nil {
		t.Fatal("redirect loop accepted")
	}
}

func TestRemoteDimensionsHeadLimit(t *testing.T) {
	png := testutil.PNG(t, 2, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(png)
		_, _ = w.Write(make([]byte, 1<<20))
	}))
	defer server.Close()

	dialer := funcDialer(func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	remote := images.NewRemote(images.RemoteOptions{Resolver: publicResolver(), Dialer: dialer})
	if _, err := remote.Dimensions(context.Background(), "http://images.example/big.png"); err == nil {
		t.Fatal("oversized head accepted")
	}
}

func TestRemoteDimensionsRejectsNonImage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>nope</html>"))
	}))
	defer server.Close()

	dialer := funcDialer(func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	remote := images.NewRemote(images.RemoteOptions{Resolver: publicResolver(), Dialer: dialer})
	if _, err := remote.Dimensions(context.Background(), "http://images.example/a.html"); err == nil {
		t.Fatal("non-image accepted")
	}
}

func TestRemoteDimensionsGzipExpansionLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		_, _ = gz.Write(testutil.PNG(t, 2, 2))
		_, _ = gz.Write(make([]byte, 1<<20))
		_ = gz.Close()
	}))
	defer server.Close()

	dialer := funcDialer(func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	remote := images.NewRemote(images.RemoteOptions{Resolver: publicResolver(), Dialer: dialer})
	if _, err := remote.Dimensions(context.Background(), "http://images.example/bomb.png"); err == nil {
		t.Fatal("gzip expansion over limit accepted")
	}
}

func tlsRemote(t *testing.T, handler http.Handler) *images.Remote {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		},
	}
	return images.NewRemote(images.RemoteOptions{Resolver: publicResolver(), Transport: transport})
}

func TestRemoteDownload(t *testing.T) {
	data := testutil.PNG(t, 4, 4)
	remote := tlsRemote(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data)
	}))
	got, mime, err := remote.Download(context.Background(), "https://example.com/a.png")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if mime != "image/png" || len(got) != len(data) {
		t.Fatalf("download mime=%q len=%d", mime, len(got))
	}
}

func TestRemoteDownloadRequiresHTTPS(t *testing.T) {
	remote := images.NewRemote(images.RemoteOptions{Resolver: publicResolver()})
	if _, _, err := remote.Download(context.Background(), "http://images.example/a.png"); err == nil {
		t.Fatal("http download accepted")
	}
}

func TestRemoteDownloadRejectsUnknownMIME(t *testing.T) {
	remote := tlsRemote(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html></html>"))
	}))
	if _, _, err := remote.Download(context.Background(), "https://example.com/a.html"); err == nil {
		t.Fatal("unknown mime accepted")
	}
}

func TestRemoteDownloadSizeLimit(t *testing.T) {
	remote := tlsRemote(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(testutil.PNG(t, 1, 1))
		chunk := make([]byte, 1<<20)
		for i := 0; i < 65; i++ {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}))
	start := time.Now()
	if _, _, err := remote.Download(context.Background(), "https://example.com/big.png"); err == nil {
		t.Fatal("oversized download accepted")
	}
	if time.Since(start) > 10*time.Second {
		t.Fatal("download limit not enforced promptly")
	}
}

func TestRemoteDownloadServerError(t *testing.T) {
	remote := tlsRemote(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusBadGateway)
	}))
	if _, _, err := remote.Download(context.Background(), "https://example.com/a.png"); err == nil {
		t.Fatal("500 download accepted")
	}
}

func TestRemoteDownloadRejectsUserinfo(t *testing.T) {
	remote := images.NewRemote(images.RemoteOptions{Resolver: publicResolver()})
	if _, _, err := remote.Download(context.Background(), "https://user:pass@images.example/a.png"); err == nil {
		t.Fatal("credentials in URL accepted")
	}
}
