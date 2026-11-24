package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func newTestRuntime(t *testing.T, options Options) (*Runtime, *store.Store) {
	t.Helper()
	st := store.New(testutil.OpenDB(t), nil)
	options.Store = st
	if options.APIKey == "" {
		options.APIKey = "test-admin-key"
	}
	rt, err := NewRuntime(options)
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}
	t.Cleanup(func() { _ = rt.Shutdown(context.Background()) })
	return rt, st
}

func TestRuntimeInitializesSchemaAndServesHealth(t *testing.T) {
	rt, st := newTestRuntime(t, Options{})

	if _, err := st.ReadSettings(context.Background()); err != nil {
		t.Fatalf("schema was not initialized: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/health?deep=1", nil)
	rec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("deep health status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := rt.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if err := st.Ping(context.Background()); err == nil {
		t.Fatal("store still answers after Shutdown, want closed database")
	}
}

func TestRuntimeShutdownStopsAdmissionAndDrainsBeforeClosingStore(t *testing.T) {
	rt, st := newTestRuntime(t, Options{})

	reservation, err := rt.tasks.Reserve(context.Background())
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	started := make(chan struct{})
	jobErr := make(chan error, 1)
	if err := reservation.Submit(func(ctx context.Context) {
		close(started)
		time.Sleep(100 * time.Millisecond)
		jobErr <- st.Ping(ctx)
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	<-started

	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		shutdownDone <- rt.Shutdown(ctx)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		reservation, err := rt.tasks.Reserve(context.Background())
		if errors.Is(err, service.ErrAdmissionClosed) {
			break
		}
		if err == nil {
			reservation.Release()
		}
		if time.Now().After(deadline) {
			t.Fatalf("admission did not close during shutdown (last err %v)", err)
		}
		time.Sleep(5 * time.Millisecond)
	}

	if err := <-jobErr; err != nil {
		t.Fatalf("archive job ran after store close: %v", err)
	}
	if err := <-shutdownDone; err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if err := st.Ping(context.Background()); err == nil {
		t.Fatal("store still answers after Shutdown")
	}
}

func TestRuntimeShutdownBudgetLogsUnfinishedTasks(t *testing.T) {
	var (
		mu   sync.Mutex
		logs []string
	)
	rt, st := newTestRuntime(t, Options{Logf: func(format string, args ...any) {
		mu.Lock()
		logs = append(logs, fmt.Sprintf(format, args...))
		mu.Unlock()
	}})

	reservation, err := rt.tasks.Reserve(context.Background())
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	started := make(chan struct{})
	finished := make(chan struct{})
	if err := reservation.Submit(func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		close(finished)
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	<-started

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err = rt.Shutdown(ctx)
	if err == nil {
		t.Fatal("Shutdown succeeded although a task ignored the budget")
	}

	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("lifetime context was not canceled after the budget expired")
	}

	mu.Lock()
	joined := strings.Join(logs, "\n")
	mu.Unlock()
	if !strings.Contains(joined, "unfinished") || !strings.Contains(joined, "1") {
		t.Fatalf("shutdown log = %q, want unfinished task count", joined)
	}
	if err := st.Ping(context.Background()); err == nil {
		t.Fatal("store still answers after Shutdown")
	}
}
