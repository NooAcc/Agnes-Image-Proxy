package service_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

func TestTasksDrainWaitsForUnsubmittedReservation(t *testing.T) {
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 1})
	reservation, err := tasks.Reserve(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() { close(started); done <- tasks.Drain(context.Background()) }()
	<-started
	select {
	case err := <-done:
		t.Fatalf("drain abandoned accepted request: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	ran := make(chan struct{})
	if err := reservation.Submit(func(context.Context) { close(ran) }); err != nil {
		t.Fatal("accepted request could not submit", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	<-ran
	if tasks.Pending() != 0 {
		t.Fatal("capacity leaked")
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func TestTasksCapacityAndReservation(t *testing.T) {
	tasks := service.NewTasks(service.TaskOptions{Workers: 2, Capacity: 2})
	ctx := context.Background()

	r1, err := tasks.Reserve(ctx)
	if err != nil {
		t.Fatalf("reserve 1: %v", err)
	}
	r2, err := tasks.Reserve(ctx)
	if err != nil {
		t.Fatalf("reserve 2: %v", err)
	}

	blockedCtx, cancel := context.WithCancel(ctx)
	blocked := make(chan error, 1)
	go func() {
		_, err := tasks.Reserve(blockedCtx)
		blocked <- err
	}()
	select {
	case err := <-blocked:
		t.Fatalf("third reserve did not block: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	if err := <-blocked; !errors.Is(err, context.Canceled) {
		t.Fatalf("third reserve error = %v", err)
	}

	// Releasing a reservation frees a slot.
	r1.Release()
	r3, err := tasks.Reserve(ctx)
	if err != nil {
		t.Fatalf("reserve after release: %v", err)
	}

	// A submitted task holds the slot until it finishes.
	done := make(chan struct{})
	if err := r2.Submit(func(ctx context.Context) { <-done }); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if err := r2.Submit(func(ctx context.Context) {}); err == nil {
		t.Fatal("double submit accepted")
	}
	r2.Release() // must be a no-op after submit
	probeCtx, probeCancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer probeCancel()
	if _, err := tasks.Reserve(probeCtx); err == nil {
		t.Fatal("slot released before submitted task finished")
	}
	close(done)
	r4, err := tasks.Reserve(ctx)
	if err != nil {
		t.Fatalf("reserve after task done: %v", err)
	}
	r3.Release()
	r4.Release()
	if err := tasks.Drain(ctx); err != nil {
		t.Fatalf("drain: %v", err)
	}
}

func TestTasksStopAdmissionAllowsExistingSubmit(t *testing.T) {
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 2})
	ctx := context.Background()
	reservation, err := tasks.Reserve(ctx)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	tasks.StopAdmission()
	if _, err := tasks.Reserve(ctx); !errors.Is(err, service.ErrAdmissionClosed) {
		t.Fatalf("reserve after stop = %v", err)
	}
	ran := make(chan struct{})
	if err := reservation.Submit(func(context.Context) { close(ran) }); err != nil {
		t.Fatalf("existing reservation submit: %v", err)
	}
	select {
	case <-ran:
	case <-time.After(time.Second):
		t.Fatal("existing reservation did not run")
	}
	if err := tasks.Drain(ctx); err != nil {
		t.Fatalf("drain: %v", err)
	}
}

func TestTasksDrainWaitsForRunningTasks(t *testing.T) {
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 1})
	reservation, err := tasks.Reserve(context.Background())
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	block := make(chan struct{})
	started := make(chan struct{})
	if err := reservation.Submit(func(context.Context) { close(started); <-block }); err != nil {
		t.Fatalf("submit: %v", err)
	}
	<-started

	drained := make(chan error, 1)
	go func() { drained <- tasks.Drain(context.Background()) }()
	select {
	case err := <-drained:
		t.Fatalf("drain returned early: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(block)
	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("drain: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("drain did not finish")
	}
}

func TestTasksDrainTimeout(t *testing.T) {
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 1})
	reservation, _ := tasks.Reserve(context.Background())
	block := make(chan struct{})
	defer close(block)
	_ = reservation.Submit(func(context.Context) { <-block })

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := tasks.Drain(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("drain = %v", err)
	}
}

func TestTasksPanicReleasesCapacity(t *testing.T) {
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 1})
	reservation, _ := tasks.Reserve(context.Background())
	if err := reservation.Submit(func(context.Context) { panic("boom") }); err != nil {
		t.Fatalf("submit: %v", err)
	}
	var again *service.Reservation
	waitFor(t, func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		reserved, err := tasks.Reserve(ctx)
		if err == nil {
			again = reserved
			return true
		}
		return false
	})
	again.Release()
	_ = tasks.Drain(context.Background())
}

type fakeEnricher struct {
	mu      sync.Mutex
	calls   [][]domain.GallerySource
	report  service.EnrichReport
	err     error
	block   chan struct{}
	started chan struct{}
}

func (f *fakeEnricher) Enrich(ctx context.Context, sources []domain.GallerySource, _ domain.Settings) (service.EnrichReport, error) {
	f.mu.Lock()
	f.calls = append(f.calls, append([]domain.GallerySource(nil), sources...))
	f.mu.Unlock()
	if f.started != nil {
		select {
		case f.started <- struct{}{}:
		default:
		}
	}
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return f.report, ctx.Err()
		}
	}
	return f.report, f.err
}

func (f *fakeEnricher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}
