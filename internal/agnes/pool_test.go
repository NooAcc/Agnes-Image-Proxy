package agnes_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

func TestClientPostsGenerationWithBearer(t *testing.T) {
	var gotPath, gotAuth, gotContentType string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBody)
		_, _ = w.Write([]byte(`{"data":[{"url":"https://img.example/a.png"}]}`))
	}))
	defer server.Close()

	client := agnes.NewClient(server.Client())
	raw, err := client.Generate(context.Background(), server.URL+"/v1", "sk-secret", map[string]any{"model": "m", "prompt": "p", "n": 1}, 5*time.Second)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if !strings.Contains(string(raw), "a.png") {
		t.Fatalf("raw = %s", raw)
	}
	if gotPath != "/v1/images/generations" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer sk-secret" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if !strings.HasPrefix(gotContentType, "application/json") {
		t.Fatalf("content type = %q", gotContentType)
	}
	if gotBody["model"] != "m" || gotBody["n"] != float64(1) {
		t.Fatalf("body = %v", gotBody)
	}
}

func TestClientRetryAfterParsing(t *testing.T) {
	cases := []struct {
		header string
		want   time.Duration
	}{
		{"120", 120 * time.Second},
		{"9999", 900 * time.Second},
		{"-5", 60 * time.Second},
		{"nonsense", 60 * time.Second},
		{"", 60 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.header, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.header != "" {
					w.Header().Set("Retry-After", tc.header)
				}
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"error":{"message":"slow down","code":"rate_limited"}}`))
			}))
			defer server.Close()

			client := agnes.NewClient(server.Client())
			_, err := client.Generate(context.Background(), server.URL, "key", map[string]any{}, time.Second)
			var httpErr *agnes.HTTPError
			if !errors.As(err, &httpErr) {
				t.Fatalf("expected HTTPError, got %T %v", err, err)
			}
			if httpErr.Status != 429 || httpErr.RetryAfter != tc.want {
				t.Fatalf("status=%d retryAfter=%v, want 429 %v", httpErr.Status, httpErr.RetryAfter, tc.want)
			}
			if httpErr.Message != "slow down" || httpErr.Code != "rate_limited" {
				t.Fatalf("message/code = %q/%q", httpErr.Message, httpErr.Code)
			}
		})
	}
}

func TestClientRetryAfterHTTPDate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", time.Now().Add(90*time.Second).UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()

	client := agnes.NewClient(server.Client())
	_, err := client.Generate(context.Background(), server.URL, "key", map[string]any{}, time.Second)
	var httpErr *agnes.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("expected HTTPError, got %T", err)
	}
	if httpErr.RetryAfter < 85*time.Second || httpErr.RetryAfter > 95*time.Second {
		t.Fatalf("retry after = %v", httpErr.RetryAfter)
	}
}

func TestClientTimeoutAndNoTokenLeak(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
	}))
	defer server.Close()

	client := agnes.NewClient(server.Client())
	_, err := client.Generate(context.Background(), server.URL, "super-secret-token", map[string]any{}, 50*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
	if strings.Contains(err.Error(), "super-secret-token") {
		t.Fatal("token leaked in error")
	}
}

func TestClientRedactsKeyFromUpstreamMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"bad key sk-live-123456","code":"unauthorized"}}`))
	}))
	defer server.Close()

	client := agnes.NewClient(server.Client())
	_, err := client.Generate(context.Background(), server.URL, "sk-live-123456", map[string]any{}, time.Second)
	var httpErr *agnes.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("expected HTTPError, got %T", err)
	}
	if strings.Contains(httpErr.Message, "sk-live-123456") {
		t.Fatalf("key leaked: %q", httpErr.Message)
	}
}

// TestPoolFailoverAcrossAccounts pins the account retry sequence and payload
// stability.
func TestPoolFailoverAcrossAccounts(t *testing.T) {
	repo := newFakeRepo(1, 2, 3)
	gen := &fakeGenerator{
		responses: map[int64]fakeResponse{
			1: {err: &agnes.HTTPError{Status: 401, Message: "unauthorized"}},
			2: {err: &agnes.HTTPError{Status: 429, RetryAfter: 60 * time.Second, Message: "limited"}},
			3: {raw: json.RawMessage(`{"data":[{"url":"https://img.example/ok.png"}]}`)},
		},
	}
	pool := agnes.NewPool(repo, gen, fixedNow)

	result, err := pool.Generate(context.Background(), sampleRequest(t), testSettings())
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(result.Images) != 1 || result.AccountID != 3 || result.AccountName != "account-3" {
		t.Fatalf("result = %+v", result)
	}
	if len(result.Attempts) != 3 {
		t.Fatalf("attempts = %+v", result.Attempts)
	}
	if result.Attempts[0].Status != 401 || result.Attempts[1].Status != 429 || result.Attempts[2].Status != 200 {
		t.Fatalf("attempt statuses = %+v", result.Attempts)
	}

	wantExclusions := [][]int64{nil, {1}, {1, 2}}
	if !reflect.DeepEqual(repo.claimExclusions, wantExclusions) {
		t.Fatalf("claim exclusions = %v", repo.claimExclusions)
	}
	if len(gen.calls) != 3 {
		t.Fatalf("calls = %d", len(gen.calls))
	}
	for i := 1; i < len(gen.calls); i++ {
		if !reflect.DeepEqual(gen.calls[0].payload, gen.calls[i].payload) {
			t.Fatalf("payload changed between attempts: %v vs %v", gen.calls[0].payload, gen.calls[i].payload)
		}
	}
	wantKeys := []string{"key-1-abcdefghij", "key-2-abcdefghij", "key-3-abcdefghij"}
	for i, key := range wantKeys {
		if gen.calls[i].key != key {
			t.Fatalf("call %d key = %q, want %q", i, gen.calls[i].key, key)
		}
	}

	if len(repo.failures) != 2 {
		t.Fatalf("failures = %+v", repo.failures)
	}
	if repo.failures[0].id != 1 || repo.failures[0].cooldown != 15*time.Minute {
		t.Fatalf("auth cooldown = %+v", repo.failures[0])
	}
	if repo.failures[1].id != 2 || repo.failures[1].cooldown != 60*time.Second {
		t.Fatalf("429 cooldown = %+v", repo.failures[1])
	}
	if len(repo.successes) != 1 || repo.successes[0].id != 3 || repo.successes[0].images != 1 {
		t.Fatalf("successes = %+v", repo.successes)
	}
}

func TestPoolClientErrorDoesNotFailover(t *testing.T) {
	repo := newFakeRepo(1, 2)
	gen := &fakeGenerator{responses: map[int64]fakeResponse{
		1: {err: &agnes.HTTPError{Status: 400, Code: "invalid_request", Message: "bad prompt"}},
	}}
	pool := agnes.NewPool(repo, gen, fixedNow)
	_, err := pool.Generate(context.Background(), sampleRequest(t), testSettings())
	if err == nil {
		t.Fatal("expected error")
	}
	var apiErr *apierrorError
	if !errors.As(err, &apiErr) || apiErr.Status != 400 {
		t.Fatalf("error = %v", err)
	}
	if len(repo.claims) != 1 || len(gen.calls) != 1 {
		t.Fatalf("claims=%d calls=%d", len(repo.claims), len(gen.calls))
	}
	if len(repo.failures) != 0 {
		t.Fatalf("client error cooled the account: %+v", repo.failures)
	}
}

func TestPoolServerErrorBecomes502(t *testing.T) {
	repo := newFakeRepo(1)
	gen := &fakeGenerator{responses: map[int64]fakeResponse{
		1: {err: &agnes.HTTPError{Status: 500, Message: "boom"}},
	}}
	pool := agnes.NewPool(repo, gen, fixedNow)
	_, err := pool.Generate(context.Background(), sampleRequest(t), testSettings())
	var apiErr *apierrorError
	if !errors.As(err, &apiErr) || apiErr.Status != 502 {
		t.Fatalf("error = %v", err)
	}
	if len(repo.failures) != 1 || repo.failures[0].cooldown < 60*time.Second {
		t.Fatalf("failures = %+v", repo.failures)
	}
}

func TestPoolTimeoutBecomes504(t *testing.T) {
	repo := newFakeRepo(1)
	gen := &fakeGenerator{responses: map[int64]fakeResponse{
		1: {err: context.DeadlineExceeded},
	}}
	pool := agnes.NewPool(repo, gen, fixedNow)
	_, err := pool.Generate(context.Background(), sampleRequest(t), testSettings())
	var apiErr *apierrorError
	if !errors.As(err, &apiErr) || apiErr.Status != 504 {
		t.Fatalf("error = %v", err)
	}
}

func TestPoolNoAccountIs503(t *testing.T) {
	repo := newFakeRepo()
	pool := agnes.NewPool(repo, &fakeGenerator{}, fixedNow)
	_, err := pool.Generate(context.Background(), sampleRequest(t), testSettings())
	var apiErr *apierrorError
	if !errors.As(err, &apiErr) || apiErr.Status != 503 {
		t.Fatalf("error = %v", err)
	}
}

func TestPoolStopsOnCancellation(t *testing.T) {
	repo := newFakeRepo(1, 2, 3)
	ctx, cancel := context.WithCancel(context.Background())
	gen := &fakeGenerator{onCall: func() { cancel() }, responses: map[int64]fakeResponse{
		1: {err: context.Canceled},
	}}
	pool := agnes.NewPool(repo, gen, fixedNow)
	_, err := pool.Generate(ctx, sampleRequest(t), testSettings())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
	if len(repo.claims) != 1 {
		t.Fatalf("claims after cancel = %d", len(repo.claims))
	}
}

func TestPoolMalformedSuccessRetries(t *testing.T) {
	repo := newFakeRepo(1, 2)
	gen := &fakeGenerator{responses: map[int64]fakeResponse{
		1: {raw: json.RawMessage(`{"data":[]}`)},
		2: {raw: json.RawMessage(`{"data":[{"url":"https://img.example/ok.png"}]}`)},
	}}
	pool := agnes.NewPool(repo, gen, fixedNow)
	result, err := pool.Generate(context.Background(), sampleRequest(t), testSettings())
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if result.AccountID != 2 || len(result.Attempts) != 2 || result.Attempts[0].Status != 502 {
		t.Fatalf("result = %+v", result)
	}
}

func TestPoolAttemptLimit(t *testing.T) {
	repo := newFakeRepo(1, 2, 3, 4)
	gen := &fakeGenerator{responses: map[int64]fakeResponse{
		1: {err: &agnes.HTTPError{Status: 500}},
		2: {err: &agnes.HTTPError{Status: 500}},
		3: {err: &agnes.HTTPError{Status: 500}},
		4: {raw: json.RawMessage(`{"data":[{"url":"https://img.example/ok.png"}]}`)},
	}}
	settings := testSettings()
	settings.MaxAttempts = 2
	pool := agnes.NewPool(repo, gen, fixedNow)
	_, err := pool.Generate(context.Background(), sampleRequest(t), settings)
	if err == nil {
		t.Fatal("expected failure after max attempts")
	}
	if len(repo.claims) != 2 {
		t.Fatalf("claims = %d", len(repo.claims))
	}
}

func TestPoolRecordsSuccessWithClaimFailCount(t *testing.T) {
	repo := newFakeRepo(1)
	repo.failCount = 4
	gen := &fakeGenerator{responses: map[int64]fakeResponse{
		1: {raw: json.RawMessage(`{"data":[{"url":"https://img.example/ok.png"},{"url":"https://img.example/two.png"}]}`)},
	}}
	pool := agnes.NewPool(repo, gen, fixedNow)
	if _, err := pool.Generate(context.Background(), sampleRequest(t), testSettings()); err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(repo.successes) != 1 || repo.successes[0].expectedFailCount != 4 || repo.successes[0].images != 2 {
		t.Fatalf("success = %+v", repo.successes)
	}
}

func TestClientRedirectDoesNotForwardBearer(t *testing.T) {
	var targetAuth string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"data":[{"url":"https://img.example/a.png"}]}`))
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/v2/images/generations", http.StatusTemporaryRedirect)
	}))
	defer source.Close()

	client := agnes.NewClient(source.Client())
	if _, err := client.Generate(context.Background(), source.URL, "bearer-secret", map[string]any{}, time.Second); err != nil {
		t.Fatalf("generate: %v", err)
	}
	if targetAuth != "" {
		t.Fatalf("bearer forwarded cross-origin: %q", targetAuth)
	}
}

var _ = domain.PixelSize{}
