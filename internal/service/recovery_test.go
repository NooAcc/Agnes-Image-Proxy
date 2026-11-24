package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

func TestHugeCancelledRequestStopsPromptly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	env := newImageEnv(t, func(ctx context.Context, index int64) (agnes.Generation, error) {
		cancel()
		return generationFor(index), nil
	})
	env.request.N = 1_000_000_000_000
	done := make(chan error, 1)
	go func() { _, err := env.images.Generate(ctx, env.request, env.settings, "huge-cancel"); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("requested-range scan blocked cancellation")
	}
	_ = env.tasks.Drain(context.Background())
	if env.tasks.Pending() != 0 {
		t.Fatal("capacity leak")
	}
}

func TestStopAdmissionWakesBlockedReservation(t *testing.T) {
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 1})
	held, _ := tasks.Reserve(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := tasks.Reserve(ctx); done <- err }()
	select {
	case err := <-done:
		t.Fatalf("reservation should wait for capacity: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	tasks.StopAdmission()
	select {
	case err := <-done:
		if !errors.Is(err, service.ErrAdmissionClosed) {
			t.Fatalf("wrong admission result: %v", err)
		}
	case <-time.After(150 * time.Millisecond):
		t.Fatal("stopped admission did not wake waiting request")
	}
	held.Release()
	_ = tasks.Drain(context.Background())
}

func TestGenerationPreservesUpstreamValidationError(t *testing.T) {
	env := newImageEnv(t, func(context.Context, int64) (agnes.Generation, error) {
		return agnes.Generation{}, apierror.Invalid("prompt", "invalid prompt", "invalid_prompt")
	})
	env.request.N = 1
	_, err := env.images.Generate(context.Background(), env.request, env.settings, "validation")
	var ae *apierror.Error
	if !errors.As(err, &ae) || ae.Status != 400 || ae.Code == nil || *ae.Code != "invalid_prompt" {
		t.Fatalf("validation error lost: %v", err)
	}
	_ = env.tasks.Drain(context.Background())
}
