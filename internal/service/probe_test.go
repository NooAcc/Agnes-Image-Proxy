package service_test

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

type probeAccount struct {
	summary domain.AccountSummary
	key     string
}

type fakeProbeStore struct {
	mu       sync.Mutex
	accounts []probeAccount
	failures []recordedProbeFailure
}

type recordedProbeFailure struct {
	id       int64
	cooldown time.Duration
}

func (f *fakeProbeStore) ListAccounts(context.Context) ([]domain.AccountSummary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]domain.AccountSummary, 0, len(f.accounts))
	for _, account := range f.accounts {
		out = append(out, account.summary)
	}
	return out, nil
}

func (f *fakeProbeStore) GetAccount(_ context.Context, id int64) (domain.Account, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, account := range f.accounts {
		if account.summary.ID == id {
			return domain.Account{ID: id, Name: account.summary.Name, APIKey: account.key}, nil
		}
	}
	return domain.Account{}, apierror.Coded(404, "account not found", "invalid_request_error", "not_found")
}

func (f *fakeProbeStore) RecordFailure(_ context.Context, id int64, cooldown time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failures = append(f.failures, recordedProbeFailure{id: id, cooldown: cooldown})
	return nil
}

func (f *fakeProbeStore) failureSnapshot() []recordedProbeFailure {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordedProbeFailure(nil), f.failures...)
}

type fakeProber struct {
	mu       sync.Mutex
	keys     []string
	inFlight atomic.Int64
	peak     atomic.Int64
	fn       func(ctx context.Context, baseURL, key string) error
}

func (f *fakeProber) ProbeModels(ctx context.Context, baseURL, key string, _ time.Duration) error {
	f.mu.Lock()
	f.keys = append(f.keys, key)
	f.mu.Unlock()
	current := f.inFlight.Add(1)
	for {
		peak := f.peak.Load()
		if current <= peak || f.peak.CompareAndSwap(peak, current) {
			break
		}
	}
	defer f.inFlight.Add(-1)
	if f.fn != nil {
		return f.fn(ctx, baseURL, key)
	}
	return nil
}

func newProbe(t *testing.T, store service.ProbeStore, prober service.Prober) *service.Probe {
	t.Helper()
	return service.NewProbe(service.ProbeOptions{Store: store, Prober: prober, ProbeTimeout: 5 * time.Second})
}

func probeSettings() domain.Settings {
	settings := domain.DefaultSettings()
	settings.ProbeConcurrency = 2
	return settings
}

func TestProbeOneSuccess(t *testing.T) {
	store := &fakeProbeStore{accounts: []probeAccount{{
		summary: domain.AccountSummary{ID: 1, Name: "a"},
		key:     "sk-account-secret",
	}}}
	prober := &fakeProber{}
	probe := newProbe(t, store, prober)

	result, err := probe.One(context.Background(), 1, probeSettings())
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if !result.OK || result.Status != 200 || result.ID != 1 || result.Message != "ok" {
		t.Fatalf("result = %+v", result)
	}
	if len(store.failureSnapshot()) != 0 {
		t.Fatal("success recorded a failure")
	}
	if len(prober.keys) != 1 || prober.keys[0] != "sk-account-secret" {
		t.Fatalf("probed keys = %v", prober.keys)
	}
}

func TestProbeOneFailureUpdatesHealth(t *testing.T) {
	store := &fakeProbeStore{accounts: []probeAccount{{
		summary: domain.AccountSummary{ID: 2, Name: "b"},
		key:     "sk-failing-secret",
	}}}
	prober := &fakeProber{fn: func(context.Context, string, string) error {
		return &agnes.HTTPError{Status: http.StatusUnauthorized, Message: "rejected sk-failing-secret"}
	}}
	probe := newProbe(t, store, prober)

	result, err := probe.One(context.Background(), 2, probeSettings())
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if result.OK || result.Status != http.StatusUnauthorized || strings.Contains(result.Message, "sk-failing-secret") {
		t.Fatalf("result = %+v", result)
	}
	failures := store.failureSnapshot()
	if len(failures) != 1 || failures[0].id != 2 || failures[0].cooldown != 15*time.Minute {
		t.Fatalf("failures = %+v", failures)
	}

	// A 429 probe uses its Retry-After delay.
	store = &fakeProbeStore{accounts: []probeAccount{{
		summary: domain.AccountSummary{ID: 3, Name: "c"}, key: "sk-rate-secret",
	}}}
	prober = &fakeProber{fn: func(context.Context, string, string) error {
		return &agnes.HTTPError{Status: http.StatusTooManyRequests, RetryAfter: 30 * time.Second}
	}}
	probe = newProbe(t, store, prober)
	if _, err := probe.One(context.Background(), 3, probeSettings()); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if failures := store.failureSnapshot(); len(failures) != 1 || failures[0].cooldown != 30*time.Second {
		t.Fatalf("429 failures = %+v", failures)
	}
}

func TestProbeOneMissingAccount(t *testing.T) {
	probe := newProbe(t, &fakeProbeStore{}, &fakeProber{})
	_, err := probe.One(context.Background(), 99, probeSettings())
	var apiErr *apierror.Error
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatalf("error = %v", err)
	}
}

func TestProbeAllConcurrencyAndOrder(t *testing.T) {
	store := &fakeProbeStore{}
	for i := int64(1); i <= 6; i++ {
		store.accounts = append(store.accounts, probeAccount{
			summary: domain.AccountSummary{ID: i, Name: "account-" + strconv.FormatInt(i, 10)},
			key:     "sk-key-" + strconv.FormatInt(i, 10),
		})
	}
	prober := &fakeProber{fn: func(ctx context.Context, _ string, key string) error {
		time.Sleep(20 * time.Millisecond)
		if strings.HasSuffix(key, "3") {
			return &agnes.HTTPError{Status: 503, Message: "temporarily down"}
		}
		return nil
	}}
	probe := newProbe(t, store, prober)
	results, err := probe.All(context.Background(), probeSettings())
	if err != nil {
		t.Fatalf("probe all: %v", err)
	}
	if len(results) != 6 {
		t.Fatalf("results = %d", len(results))
	}
	ids := make([]int64, 0, len(results))
	for _, result := range results {
		ids = append(ids, result.ID)
	}
	if !sort.SliceIsSorted(ids, func(i, j int) bool { return ids[i] < ids[j] }) {
		t.Fatalf("result order = %v", ids)
	}
	if results[2].OK || results[2].Status != 503 {
		t.Fatalf("failed item = %+v", results[2])
	}
	if prober.peak.Load() > 2 {
		t.Fatalf("peak concurrency = %d", prober.peak.Load())
	}
}

func TestProbeAllCancellation(t *testing.T) {
	store := &fakeProbeStore{}
	for i := int64(1); i <= 20; i++ {
		store.accounts = append(store.accounts, probeAccount{
			summary: domain.AccountSummary{ID: i, Name: "a"}, key: "sk-key",
		})
	}
	blocked := make(chan struct{})
	prober := &fakeProber{fn: func(ctx context.Context, _ string, _ string) error {
		select {
		case <-blocked:
		case <-ctx.Done():
			return ctx.Err()
		}
		return nil
	}}
	probe := newProbe(t, store, prober)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := probe.All(ctx, probeSettings())
		done <- err
	}()
	waitFor(t, func() bool { return prober.inFlight.Load() == 2 })
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("probe all did not stop")
	}
	close(blocked)
}
