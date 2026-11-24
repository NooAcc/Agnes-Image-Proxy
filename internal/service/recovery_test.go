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

func TestHugeCancelledRequestArchivesExecutedSuccessPromptly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	env := newImageEnv(t, func(ctx context.Context, index int64) (agnes.Generation, error) {
		if index == 0 {
			cancel()
			return generationFor(index), nil
		}
		<-ctx.Done()
		return agnes.Generation{}, ctx.Err()
	})
	env.request.N = 1_000_000_000_000
	done := make(chan *service.ImageResult, 1)
	go func() {
		result, _ := env.images.Generate(ctx, env.request, env.settings, "huge-cancel")
		done <- result
	}()
	select {
	case result := <-done:
		if result == nil || len(result.Response.Data) != 1 {
			t.Fatalf("lost successful output: %+v", result)
		}
		if err := result.CommitArchive(); err != nil {
			t.Fatal(err)
		}
		if len(env.archiver.wait(t).Images) != 1 {
			t.Fatal("success not archived")
		}
		if err := env.tasks.Drain(context.Background()); err != nil {
			t.Fatal(err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("cancellation trapped successful output in requested-range scan")
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
