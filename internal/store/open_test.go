package store_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
)

func TestOpenRejectsInvalidURL(t *testing.T) {
	cases := []string{
		"",
		"file:local.db",
		"http://example.turso.io",
		"https://user:pass@example.turso.io",
		"https://example.turso.io/db",
		"https://example.turso.io?x=1",
		"https://example.turso.io#frag",
	}
	for _, raw := range cases {
		if _, err := store.Open(context.Background(), store.Options{URL: raw, AuthToken: "tok"}); err == nil {
			t.Fatalf("url %q should be rejected", raw)
		}
	}
}

func TestOpenNormalizesConnectionFailure(t *testing.T) {
	start := time.Now()
	_, err := store.Open(context.Background(), store.Options{
		URL:       "https://127.0.0.1:1",
		AuthToken: "super-secret-token",
		Timeout:   300 * time.Millisecond,
	})
	if err == nil {
		t.Fatal("expected connection failure")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("connection attempt was not bounded: %v", elapsed)
	}
	var apiErr *apierror.Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected apierror, got %T", err)
	}
	if apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", apiErr.Status)
	}
	if strings.Contains(err.Error(), "super-secret-token") {
		t.Fatal("auth token leaked in error")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// TestOpenSpeaksHranaProtocol proves the production connector path: the driver
// posts Hrana v2 pipelines with the bearer token and database/sql consumes the
// result. The transport is intercepted through http.DefaultTransport because
// the driver exposes no client injection point.
func TestOpenSpeaksHranaProtocol(t *testing.T) {
	var mu sync.Mutex
	var calls int
	var auth, path string
	body := `{"results":[{"type":"ok","response":{"type":"execute","result":{"cols":[{"name":"1","decltype":null}],"rows":[[{"type":"integer","value":"1"}]],"affected_row_count":0,"last_insert_rowid":null}}}]}`

	oldTransport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		calls++
		auth = r.Header.Get("Authorization")
		path = r.URL.Path
		mu.Unlock()
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    r,
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = oldTransport })

	s, err := store.Open(context.Background(), store.Options{
		URL:       "https://db.example.turso.io",
		AuthToken: "tok-123",
		Timeout:   2 * time.Second,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()

	mu.Lock()
	defer mu.Unlock()
	if calls == 0 {
		t.Fatal("driver never called the remote endpoint")
	}
	if auth != "Bearer tok-123" {
		t.Fatalf("authorization = %q", auth)
	}
	if path != "/v2/pipeline" {
		t.Fatalf("path = %q", path)
	}
}
