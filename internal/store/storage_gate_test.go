package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition not reached")
}

func TestStorageGateZeroValueAndExclusive(t *testing.T) {
	var gate storageGate
	release, err := gate.acquire(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := gate.acquire(ctx, true); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("exclusive acquire while shared held = %v", err)
	}
	release()
	release, err = gate.acquire(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	release()
}

func TestStorageGateCancellationAndWriterPriority(t *testing.T) {
	var gate storageGate
	sharedRelease, err := gate.acquire(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	writerCanceled := make(chan error, 1)
	writerCtx, cancelWriter := context.WithCancel(context.Background())
	go func() {
		_, err := gate.acquire(writerCtx, true)
		writerCanceled <- err
	}()
	waitFor(t, func() bool {
		gate.mu.Lock()
		defer gate.mu.Unlock()
		return gate.waitingWriters == 1
	})

	// A waiting writer blocks new readers: no starvation by an endless stream
	// of shared acquisitions.
	readerCtx, cancelReader := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelReader()
	if _, err := gate.acquire(readerCtx, false); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("reader bypassed waiting writer: %v", err)
	}

	cancelWriter()
	if err := <-writerCanceled; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled writer = %v", err)
	}
	waitFor(t, func() bool {
		gate.mu.Lock()
		defer gate.mu.Unlock()
		return gate.waitingWriters == 0
	})

	// Once the writer gives up, readers proceed again.
	readerRelease, err := gate.acquire(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	readerRelease()
	sharedRelease()

	writerRelease, err := gate.acquire(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	writerRelease()
}
