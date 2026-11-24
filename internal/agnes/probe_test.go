package agnes_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
)

func TestClientProbesModelsEndpoint(t *testing.T) {
	var gotPath, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[]}`))
	}))
	defer server.Close()

	client := agnes.NewClient(server.Client())
	if err := client.ProbeModels(context.Background(), server.URL+"/v1", "probe-key-secret", time.Second); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if gotPath != "/v1/models" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer probe-key-secret" {
		t.Fatalf("authorization = %q", gotAuth)
	}
}

func TestClientProbeReportsStatusAndRedactsKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"bad key probe-key-secret"}}`))
	}))
	defer server.Close()

	client := agnes.NewClient(server.Client())
	err := client.ProbeModels(context.Background(), server.URL+"/v1", "probe-key-secret", time.Second)
	var httpErr *agnes.HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusUnauthorized {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), "probe-key-secret") {
		t.Fatal("probe error leaked the key")
	}
}

func TestClientProbeTimesOut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := agnes.NewClient(server.Client())
	err := client.ProbeModels(context.Background(), server.URL+"/v1", "probe-key-secret", 30*time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v", err)
	}
}
