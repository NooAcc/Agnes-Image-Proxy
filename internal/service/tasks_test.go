package service_test

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

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

type fakeArchiveStore struct {
	mu         sync.Mutex
	inserts    []domain.GalleryInsert
	enrichLogs []domain.RequestLog
	insertErr  error
	failFirst  bool
}

func (f *fakeArchiveStore) InsertGallery(_ context.Context, insert domain.GalleryInsert) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.insertErr != nil {
		return 0, f.insertErr
	}
	if f.failFirst && len(insert.Image) > 0 {
		f.failFirst = false
		return 0, errors.New("blob write failed")
	}
	f.inserts = append(f.inserts, insert)
	return int64(len(f.inserts)), nil
}

func (f *fakeArchiveStore) RecordEnrichment(_ context.Context, log domain.RequestLog) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.enrichLogs = append(f.enrichLogs, log)
	return nil
}

func (f *fakeArchiveStore) snapshot() ([]domain.GalleryInsert, []domain.RequestLog) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]domain.GalleryInsert(nil), f.inserts...), append([]domain.RequestLog(nil), f.enrichLogs...)
}

type fakeDownloader struct {
	data []byte
	mime string
	err  error
	urls []string
}

func (f *fakeDownloader) Download(_ context.Context, url string) ([]byte, string, error) {
	f.urls = append(f.urls, url)
	if f.err != nil {
		return nil, "", f.err
	}
	return f.data, f.mime, nil
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

func archiverJob(t *testing.T, settings domain.Settings) service.ArchiveJob {
	t.Helper()
	pngBytes := testutil.PNG(t, 2, 2)
	encoded := base64.StdEncoding.EncodeToString(pngBytes)
	url := "https://img.example/b.png"
	measured := domain.PixelSize{Width: 10, Height: 20}
	return service.ArchiveJob{
		RequestID:    "req-1",
		Endpoint:     "generations",
		Model:        "model",
		Prompt:       "prompt",
		ExpectedSize: "1024x1024",
		Settings:     settings,
		Images: []domain.GeneratedImage{
			{
				Image:       domain.OutputImage{Base64: &encoded},
				Measurement: domain.Measurement{Size: &measured, Format: strPtr("png")},
				AccountID:   7,
				AccountName: "account-7",
			},
			{
				Image:       domain.OutputImage{URL: &url},
				Measurement: domain.Measurement{},
				AccountID:   7,
				AccountName: "account-7",
			},
		},
	}
}

func TestArchiveWritesRowsAndEnriches(t *testing.T) {
	store := &fakeArchiveStore{}
	downloader := &fakeDownloader{data: testutil.PNG(t, 3, 3), mime: "image/png"}
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Succeeded: 1}}
	archiver := service.NewArchiver(service.ArchiverOptions{
		Store: store, Downloader: downloader, Enricher: enricher,
	})
	settings := domain.DefaultSettings()
	settings.ImageServiceBaseURL = "https://edge.example"
	job := archiverJob(t, settings)
	if err := archiver.Run(context.Background(), job); err != nil {
		t.Fatalf("run: %v", err)
	}

	inserts, logs := store.snapshot()
	if len(inserts) != 2 {
		t.Fatalf("inserts = %d", len(inserts))
	}
	if len(inserts[0].Image) == 0 || inserts[0].ImageMIME == nil || *inserts[0].ImageMIME != "image/png" {
		t.Fatalf("base64 image not stored: %+v", inserts[0])
	}
	if inserts[0].SizeActual == nil || *inserts[0].SizeActual != "10x20" || inserts[0].SizeRequest != "1024x1024" {
		t.Fatalf("size snapshot = %+v", inserts[0])
	}
	if inserts[0].AccountID == nil || *inserts[0].AccountID != 7 || inserts[0].AccountName != "account-7" {
		t.Fatalf("account snapshot = %+v", inserts[0])
	}
	if len(inserts[1].Image) == 0 || inserts[1].SourceURL == nil || *inserts[1].SourceURL != "https://img.example/b.png" {
		t.Fatalf("url image = %+v", inserts[1])
	}
	if inserts[1].SizeActual != nil {
		t.Fatalf("unexpected measured size: %v", inserts[1].SizeActual)
	}
	if enricher.callCount() != 2 {
		t.Fatalf("enrich calls = %d", enricher.callCount())
	}
	if len(logs) != 1 || logs[0].Category != "enrich" || logs[0].Requested != 2 || logs[0].Images != 2 {
		t.Fatalf("enrich logs = %+v", logs)
	}
}

func TestArchiveDownloadFailureKeepsURL(t *testing.T) {
	store := &fakeArchiveStore{}
	downloader := &fakeDownloader{err: errors.New("network down")}
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Failed: 1}}
	archiver := service.NewArchiver(service.ArchiverOptions{Store: store, Downloader: downloader, Enricher: enricher})
	settings := domain.DefaultSettings()
	settings.ImageServiceBaseURL = "https://edge.example"
	job := archiverJob(t, settings)
	job.Images = job.Images[1:] // URL-only image
	if err := archiver.Run(context.Background(), job); err != nil {
		t.Fatalf("download failure must not fail archiving: %v", err)
	}
	inserts, _ := store.snapshot()
	if len(inserts) != 1 || inserts[0].Image != nil || inserts[0].SourceURL == nil {
		t.Fatalf("unarchived row = %+v", inserts[0])
	}
	if enricher.callCount() != 1 {
		t.Fatalf("enrich calls = %d", enricher.callCount())
	}
}

func TestArchiveSkipsEnrichmentWhenDisabled(t *testing.T) {
	store := &fakeArchiveStore{}
	downloader := &fakeDownloader{data: testutil.PNG(t, 3, 3), mime: "image/png"}
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Succeeded: 1}}
	archiver := service.NewArchiver(service.ArchiverOptions{Store: store, Downloader: downloader, Enricher: enricher})
	job := archiverJob(t, domain.DefaultSettings())
	if err := archiver.Run(context.Background(), job); err != nil {
		t.Fatalf("run: %v", err)
	}
	if enricher.callCount() != 0 {
		t.Fatalf("enricher called while disabled: %d", enricher.callCount())
	}
	if _, logs := store.snapshot(); len(logs) != 0 {
		t.Fatalf("fake enrich log while disabled: %+v", logs)
	}
}

func TestArchiveBlobFailureFallsBackToMetadataAndBase64Enrichment(t *testing.T) {
	store := &fakeArchiveStore{failFirst: true}
	downloader := &fakeDownloader{data: testutil.PNG(t, 3, 3), mime: "image/png"}
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Succeeded: 1}}
	archiver := service.NewArchiver(service.ArchiverOptions{Store: store, Downloader: downloader, Enricher: enricher})
	settings := domain.DefaultSettings()
	settings.ImageServiceBaseURL = "https://edge.example"
	job := archiverJob(t, settings)
	job.Images = job.Images[1:]
	if err := archiver.Run(context.Background(), job); err != nil {
		t.Fatalf("run: %v", err)
	}
	inserts, _ := store.snapshot()
	if len(inserts) != 1 || inserts[0].Image != nil || inserts[0].SourceURL == nil {
		t.Fatalf("metadata fallback row = %+v", inserts[0])
	}
	enricher.mu.Lock()
	defer enricher.mu.Unlock()
	if len(enricher.calls) != 1 || len(enricher.calls[0][0].Data) == 0 {
		t.Fatalf("base64 enrichment fallback missing: %+v", enricher.calls)
	}
}
