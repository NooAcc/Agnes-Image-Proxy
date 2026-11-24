package service_test

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

type imageTestEnv struct {
	images   *service.Images
	tasks    *service.Tasks
	logs     *fakeRequestLogs
	archiver *fakeArchiver
	measurer *fakeMeasurer
	settings domain.Settings
	request  domain.ImageRequest
}

type fakeRequestLogs struct {
	mu   sync.Mutex
	logs []domain.RequestLog
	ctxs []context.Context
}

func (f *fakeRequestLogs) RecordRequest(ctx context.Context, log domain.RequestLog) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs = append(f.logs, log)
	f.ctxs = append(f.ctxs, ctx)
	return nil
}

func (f *fakeRequestLogs) snapshot() []domain.RequestLog {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]domain.RequestLog(nil), f.logs...)
}

type fakeArchiver struct {
	mu   sync.Mutex
	jobs []service.EnrichmentJob
	done chan struct{}
}

func newFakeArchiver() *fakeArchiver {
	return &fakeArchiver{done: make(chan struct{}, 16)}
}

func (f *fakeArchiver) Run(_ context.Context, job service.EnrichmentJob) error {
	f.mu.Lock()
	f.jobs = append(f.jobs, job)
	f.mu.Unlock()
	f.done <- struct{}{}
	return nil
}

func (f *fakeArchiver) wait(t *testing.T) service.EnrichmentJob {
	t.Helper()
	select {
	case <-f.done:
	case <-time.After(2 * time.Second):
		t.Fatal("archive job not submitted")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.jobs[len(f.jobs)-1]
}

func (f *fakeArchiver) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.jobs)
}

type measureCall struct {
	outputs      []domain.OutputImage
	measurements []domain.Measurement
}

type fakeMeasurer struct {
	mu    sync.Mutex
	calls []measureCall
	build func(index int, output domain.OutputImage) domain.Measurement
	warn  []string
}

func (f *fakeMeasurer) Measure(_ context.Context, outputs []domain.OutputImage, _ domain.Settings) ([]domain.Measurement, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	measurements := make([]domain.Measurement, len(outputs))
	for i, output := range outputs {
		if f.build != nil {
			measurements[i] = f.build(i, output)
		}
	}
	f.calls = append(f.calls, measureCall{outputs: append([]domain.OutputImage(nil), outputs...), measurements: measurements})
	return measurements, f.warn
}

func (f *fakeMeasurer) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func newImageEnv(t *testing.T, subrequest func(context.Context, int64) (agnes.Generation, error)) *imageTestEnv {
	t.Helper()
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 8})
	env := &imageTestEnv{
		tasks:    tasks,
		logs:     &fakeRequestLogs{},
		archiver: newFakeArchiver(),
		measurer: &fakeMeasurer{build: fixedMeasurement},
		settings: domain.DefaultSettings(),
	}
	env.images = service.NewImages(service.ImageOptions{
		Tasks:      tasks,
		Edge:       env.measurer,
		Enrichment: env.archiver,
		Delivery: deliveryRunnerFunc(func(ctx context.Context, in service.DeliveryInput) (service.DeliveredImage, error) {
			return deliveredFor(in), nil
		}),
		Logs:        env.logs,
		Subrequest:  subrequest,
		Workers:     4,
		MaxInFlight: 4,
		Now:         func() time.Time { return time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC) },
	})
	env.request = domain.ImageRequest{
		Endpoint:       "generations",
		Model:          "model",
		Prompt:         "prompt",
		N:              5,
		Size:           domain.ResolvedSize{Mode: "tier", Tier: "1K", Ratio: strPtr("1:1"), DerivedRatio: "1:1", Expected: domain.PixelSize{Width: 1024, Height: 1024}},
		ResponseFormat: "url",
		Warnings:       []string{"quality"},
	}
	return env
}

func fixedMeasurement(_ int, _ domain.OutputImage) domain.Measurement {
	return domain.Measurement{Size: &domain.PixelSize{Width: 864, Height: 1152}, Format: strPtr("png")}
}

func generationFor(index int64) agnes.Generation {
	url := "https://img.example/" + itoa(index) + ".png"
	return agnes.Generation{
		Images:      []domain.OutputImage{{URL: &url}},
		AccountID:   index + 10,
		AccountName: "account-" + itoa(index),
		Attempts: []domain.Attempt{{
			Index: 0, AccountID: index + 10, AccountName: "account-" + itoa(index), Status: 200, DurationMS: 5,
		}},
	}
}

func itoa(value int64) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

func TestGenerationPartialSuccess(t *testing.T) {
	delays := map[int64]time.Duration{0: 30 * time.Millisecond, 2: 10 * time.Millisecond, 4: 0}
	env := newImageEnv(t, func(ctx context.Context, index int64) (agnes.Generation, error) {
		switch index {
		case 1:
			return agnes.Generation{}, apierror.Coded(502, "upstream error", "server_error", "upstream_error")
		case 3:
			return agnes.Generation{}, apierror.Coded(429, "rate limited", "server_error", "upstream_rate_limited").
				WithHeader("Retry-After", "30")
		}
		time.Sleep(delays[index])
		return generationFor(index), nil
	})

	result, err := env.images.Generate(context.Background(), env.request, env.settings, "req-1")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(result.Images) != 3 || result.Created == 0 || result.Size != "864x1152" {
		t.Fatalf("response = %+v", result)
	}
	for i, want := range []int64{0, 2, 4} {
		item := result.Images[i]
		if item.SourceURL != "https://img.example/"+itoa(want)+".png" {
			t.Fatalf("data[%d] = %+v (order not preserved)", i, item)
		}
	}
	headers := result.Headers
	wants := map[string]string{
		"X-Agnes-Requested": "5", "X-Agnes-Succeeded": "3", "X-Agnes-Failed": "2",
		"X-Agnes-Resolved-Size": "1K 1:1", "X-Agnes-Failure-Statuses": "502,429",
	}
	for name, want := range wants {
		if got := headers.Get(name); got != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	warnings := headers.Get("X-Agnes-Warnings")
	if warnings != "quality,partial-success" {
		t.Fatalf("warnings = %q", warnings)
	}

	logs := env.logs.snapshot()
	if len(logs) != 1 {
		t.Fatalf("logs = %+v", logs)
	}
	log := logs[0]
	if log.RequestID != "req-1" || log.Category != "request" || log.Stage != "complete" || log.Status != 200 || !log.OK ||
		log.Requested != 5 || log.Images != 3 || log.Failed != 2 || log.Model != "model" || log.Endpoint != "generations" {
		t.Fatalf("log = %+v", log)
	}
	if log.SizeRequest == nil || *log.SizeRequest != "1K 1:1" || log.SizeActual == nil || *log.SizeActual != "864x1152" {
		t.Fatalf("log sizes = %+v", log)
	}
	if len(log.Attempts) != 3 {
		t.Fatalf("log attempts = %d", len(log.Attempts))
	}

	if err := result.CommitEnrichment(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	job := env.archiver.wait(t)
	if len(job.IDs) != 3 || job.RequestID != "req-1" || job.Model != "model" {
		t.Fatalf("job: %+v", job)
	}
	if err := result.CommitEnrichment(); !errors.Is(err, service.ErrReservationUsed) {
		t.Fatalf("second commit = %v", err)
	}
	result.CancelEnrichment()
}

func TestGenerationAllFailuresAggregate(t *testing.T) {
	env := newImageEnv(t, func(ctx context.Context, index int64) (agnes.Generation, error) {
		switch index % 3 {
		case 0:
			return agnes.Generation{}, apierror.Coded(503, "no account", "server_error", "no_account")
		case 1:
			return agnes.Generation{}, apierror.Coded(502, "bad gateway", "server_error", "upstream_error")
		default:
			return agnes.Generation{}, apierror.Coded(429, "limited", "server_error", "upstream_rate_limited").
				WithHeader("Retry-After", "30")
		}
	})
	result, err := env.images.Generate(context.Background(), env.request, env.settings, "req-2")
	if result != nil {
		t.Fatalf("failure returned a result: %+v", result)
	}
	var apiErr *apierror.Error
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTooManyRequests || apiErr.Headers.Get("Retry-After") != "30" {
		t.Fatalf("error = %v", err)
	}
	logs := env.logs.snapshot()
	if len(logs) != 1 || logs[0].Status != 429 || logs[0].Images != 0 || logs[0].Failed != 5 || logs[0].OK {
		t.Fatalf("logs = %+v", logs)
	}
	// The reservation was released on total failure.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	reservation, err := env.tasks.Reserve(ctx)
	if err != nil {
		t.Fatalf("capacity leaked: %v", err)
	}
	reservation.Release()
	_ = env.tasks.Drain(context.Background())
}

func TestGenerationMeasuresOnceAndSnapshotsSize(t *testing.T) {
	env := newImageEnv(t, func(ctx context.Context, index int64) (agnes.Generation, error) {
		return generationFor(index), nil
	})
	result, err := env.images.Generate(context.Background(), env.request, env.settings, "req-3")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	measurer := env.measurer
	if measurer.callCount() != 1 {
		t.Fatalf("measure calls = %d", measurer.callCount())
	}
	if len(measurer.calls[0].outputs) != 5 {
		t.Fatalf("measured outputs = %d", len(measurer.calls[0].outputs))
	}
	logs := env.logs.snapshot()
	if len(logs) != 1 || logs[0].SizeActual == nil || *logs[0].SizeActual != "864x1152" {
		t.Fatalf("log = %+v", logs)
	}
	if result.Size != "864x1152" || result.Headers.Get("X-Agnes-Failed") != "0" {
		t.Fatalf("response = %+v headers=%v", result, result.Headers)
	}
	result.CancelEnrichment()
}

func TestGenerationCancellationStopsDispatch(t *testing.T) {
	var started atomic.Int64
	env := newImageEnv(t, func(ctx context.Context, index int64) (agnes.Generation, error) {
		started.Add(1)
		<-ctx.Done()
		return agnes.Generation{}, ctx.Err()
	})
	env.request.N = 1000
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := env.images.Generate(ctx, env.request, env.settings, "req-4")
		done <- err
	}()
	waitFor(t, func() bool { return started.Load() >= 4 })
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled generation returned no error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("generation did not stop after cancel")
	}
	if got := started.Load(); got > 4 {
		t.Fatalf("dispatched %d subrequests (workers=4)", got)
	}
	probeCtx, probeCancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer probeCancel()
	reservation, err := env.tasks.Reserve(probeCtx)
	if err != nil {
		t.Fatalf("capacity leaked after cancel: %v", err)
	}
	reservation.Release()
	_ = env.tasks.Drain(context.Background())
}

func TestGenerationGlobalInFlightBound(t *testing.T) {
	var inFlight, peak atomic.Int64
	env := newImageEnv(t, func(ctx context.Context, index int64) (agnes.Generation, error) {
		current := inFlight.Add(1)
		for {
			old := peak.Load()
			if current <= old || peak.CompareAndSwap(old, current) {
				break
			}
		}
		time.Sleep(2 * time.Millisecond)
		inFlight.Add(-1)
		return generationFor(index), nil
	})
	env.request.N = 200
	first, err := env.images.Generate(context.Background(), env.request, env.settings, "req-5")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	first.CancelEnrichment()
	second, err := env.images.Generate(context.Background(), env.request, env.settings, "req-6")
	if err != nil {
		t.Fatalf("generate 2: %v", err)
	}
	second.CancelEnrichment()
	if peak.Load() > 4 {
		t.Fatalf("peak in-flight = %d (max 4)", peak.Load())
	}
	_ = env.tasks.Drain(context.Background())
}

func TestGenerationPayloadOrderingStable(t *testing.T) {
	// Successes reported in a scrambled order still map back to index order.
	var mu sync.Mutex
	results := make(map[int64]agnes.Generation)
	for _, index := range []int64{0, 1, 2, 3} {
		results[index] = generationFor(index)
	}
	var completed []int64
	env := newImageEnv(t, func(ctx context.Context, index int64) (agnes.Generation, error) {
		if index == 3 {
			time.Sleep(20 * time.Millisecond)
		}
		mu.Lock()
		completed = append(completed, index)
		mu.Unlock()
		return results[index], nil
	})
	env.request.N = 4
	result, err := env.images.Generate(context.Background(), env.request, env.settings, "req-7")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	var order []int64
	for _, item := range result.Images {
		for index := int64(0); index < 4; index++ {
			if item.SourceURL == "https://img.example/"+itoa(index)+".png" {
				order = append(order, index)
			}
		}
	}
	if !sort.SliceIsSorted(order, func(i, j int) bool { return order[i] < order[j] }) || len(order) != 4 {
		t.Fatalf("response order = %v", order)
	}
	result.CancelEnrichment()
}
