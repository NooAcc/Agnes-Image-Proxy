package service

import (
	"context"
	"errors"
	"sync"
)

// Task lifecycle errors.
var (
	ErrAdmissionClosed = errors.New("task admission is closed")
	ErrReservationUsed = errors.New("reservation already submitted or released")
	ErrTasksClosed     = errors.New("task queue is closed")
)

// TaskOptions configures background task workers.
type TaskOptions struct {
	Workers  int
	Capacity int
	Context  context.Context
	OnPanic  func(any)
}

// Tasks owns a bounded worker pool and admission semaphore. One reservation
// represents one client request and is released when its archive task ends.
type Tasks struct {
	sem           chan struct{}
	admissionDone chan struct{}
	jobs          chan func(context.Context)
	ctx           context.Context
	onPanic       func(any)

	mu              sync.Mutex
	admissionClosed bool
	jobsClosed      bool

	wg      sync.WaitGroup
	pending sync.WaitGroup
}

// NewTasks starts the configured workers.
func NewTasks(options TaskOptions) *Tasks {
	workers := options.Workers
	if workers < 1 {
		workers = 1
	}
	capacity := options.Capacity
	if capacity < workers {
		capacity = workers
	}
	ctx := options.Context
	if ctx == nil {
		ctx = context.Background()
	}
	tasks := &Tasks{
		sem:           make(chan struct{}, capacity),
		admissionDone: make(chan struct{}),
		jobs:          make(chan func(context.Context), capacity),
		ctx:           ctx,
		onPanic:       options.OnPanic,
	}
	for i := 0; i < workers; i++ {
		tasks.wg.Add(1)
		go tasks.worker()
	}
	return tasks
}

func (t *Tasks) worker() {
	defer t.wg.Done()
	for job := range t.jobs {
		job(t.ctx)
	}
}

// Reserve acquires one request-level task slot, honoring context cancellation.
func (t *Tasks) Reserve(ctx context.Context) (*Reservation, error) {
	t.mu.Lock()
	closed := t.admissionClosed
	t.mu.Unlock()
	if closed {
		return nil, ErrAdmissionClosed
	}

	select {
	case t.sem <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.admissionDone:
		return nil, ErrAdmissionClosed
	}

	t.mu.Lock()
	closed = t.admissionClosed
	if !closed {
		t.pending.Add(1)
	}
	t.mu.Unlock()
	if closed {
		<-t.sem
		return nil, ErrAdmissionClosed
	}
	return &Reservation{tasks: t}, nil
}

// Pending reports how many request slots are still reserved, including jobs
// currently running. It is only a diagnostic snapshot.
func (t *Tasks) Pending() int {
	return len(t.sem)
}

// StopAdmission rejects new reservations; existing reservations may still
// submit their accepted work.
func (t *Tasks) StopAdmission() {
	t.mu.Lock()
	if !t.admissionClosed {
		t.admissionClosed = true
		close(t.admissionDone)
	}
	t.mu.Unlock()
}

// Drain closes the queue and waits for workers, bounded by ctx.
func (t *Tasks) Drain(ctx context.Context) error {
	t.StopAdmission()
	done := make(chan struct{})
	go func() {
		t.pending.Wait()
		t.mu.Lock()
		if !t.jobsClosed {
			t.jobsClosed = true
			close(t.jobs)
		}
		t.mu.Unlock()
		t.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (t *Tasks) releaseToken() {
	<-t.sem
	t.pending.Done()
}

// Reservation is a single client request's capacity slot. It may be released
// unused or transferred to the worker queue exactly once.
type Reservation struct {
	tasks *Tasks
	mu    sync.Mutex

	submitted bool
	released  bool
}

// Submit transfers the reservation to the worker queue. Capacity is released
// when the task finishes (including after a panic).
func (r *Reservation) Submit(task func(context.Context)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.submitted || r.released {
		return ErrReservationUsed
	}
	tasks := r.tasks
	tasks.mu.Lock()
	defer tasks.mu.Unlock()
	if tasks.jobsClosed {
		return ErrTasksClosed
	}
	r.submitted = true
	tasks.jobs <- func(ctx context.Context) {
		defer tasks.releaseToken()
		defer func() {
			if recovered := recover(); recovered != nil && tasks.onPanic != nil {
				tasks.onPanic(recovered)
			}
		}()
		task(ctx)
	}
	return nil
}

// Release frees the slot when no work was submitted. It is a no-op after a
// successful Submit (the worker owns the slot) or a previous Release.
func (r *Reservation) Release() {
	r.mu.Lock()
	if r.submitted || r.released {
		r.mu.Unlock()
		return
	}
	r.released = true
	r.mu.Unlock()
	r.tasks.releaseToken()
}
