package service_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

type deliveryRunnerFunc func(context.Context, service.DeliveryInput) (service.DeliveredImage, error)

func (f deliveryRunnerFunc) Deliver(ctx context.Context, in service.DeliveryInput) (service.DeliveredImage, error) {
	return f(ctx, in)
}

type enrichmentRunnerFunc func(context.Context, service.EnrichmentJob) error

func (f enrichmentRunnerFunc) Run(ctx context.Context, job service.EnrichmentJob) error {
	return f(ctx, job)
}
func deliveredFor(in service.DeliveryInput) service.DeliveredImage {
	return service.DeliveredImage{Stored: domain.StoredImage{ID: in.SubrequestIndex*10 + int64(in.ImageIndex) + 1, PublicID: fmt.Sprintf("%032x", in.SubrequestIndex*10+int64(in.ImageIndex)+1), MIME: "image/png", Bytes: 68}, SourceURL: in.SourceURL}
}
func newDeliveredEnv(t *testing.T, n int64, runner deliveryRunnerFunc, subrequest func(context.Context, int64) (agnes.Generation, error), enrichment enrichmentRunnerFunc) (*service.Images, *service.Tasks, domain.ImageRequest) {
	t.Helper()
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 8})
	t.Cleanup(func() { _ = tasks.Drain(context.Background()) })
	im := service.NewImages(service.ImageOptions{Tasks: tasks, Delivery: runner, Enrichment: enrichment, Subrequest: subrequest, Workers: 3, MaxInFlight: 2})
	req := domain.ImageRequest{Endpoint: "generations", Model: "m", Prompt: "p", N: n, ResponseFormat: "url", Size: domain.ResolvedSize{Tier: "1K", Expected: domain.PixelSize{Width: 1024, Height: 1024}}}
	return im, tasks, req
}

type cancelMeasurer struct{ cancel context.CancelFunc }

func (m cancelMeasurer) Measure(context.Context, []domain.OutputImage, domain.Settings) ([]domain.Measurement, []string) {
	m.cancel()
	return nil, []string{"size-measure-failed"}
}

func TestGenerationCancelDuringMeasurementKeepsSavedIDs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 2})
	defer tasks.Drain(context.Background())
	jobs := make(chan service.EnrichmentJob, 1)
	im := service.NewImages(service.ImageOptions{Tasks: tasks, Delivery: deliveryRunnerFunc(func(_ context.Context, in service.DeliveryInput) (service.DeliveredImage, error) {
		return deliveredFor(in), nil
	}), Subrequest: func(_ context.Context, index int64) (agnes.Generation, error) { return generationFor(index), nil }, Edge: cancelMeasurer{cancel}, Enrichment: enrichmentRunnerFunc(func(_ context.Context, job service.EnrichmentJob) error { jobs <- job; return nil })})
	req := domain.ImageRequest{Endpoint: "generations", Model: "m", Prompt: "p", N: 1, ResponseFormat: "url"}
	result, err := im.Generate(ctx, req, domain.DefaultSettings(), "request")
	if result != nil {
		result.CancelEnrichment()
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("measurement cancellation became success: %v", err)
	}
	if err := tasks.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case job := <-jobs:
		if len(job.IDs) != 1 || job.IDs[0] != 1 {
			t.Fatal("saved IDs lost", job)
		}
	default:
		t.Fatal("saved IDs were not handed off")
	}
	if tasks.Pending() != 0 {
		t.Fatal("capacity leaked")
	}
}

func TestGenerationAllDeliveryFailuresKeepStageCode(t *testing.T) {
	for _, tc := range []struct {
		status int
		code   string
	}{{502, "image_download_failed"}, {503, "image_persist_failed"}, {504, "image_download_timeout"}} {
		im, tasks, req := newDeliveredEnv(t, 1, func(context.Context, service.DeliveryInput) (service.DeliveredImage, error) {
			return service.DeliveredImage{}, apierror.Coded(tc.status, "delivery failed", "server_error", tc.code)
		}, func(ctx context.Context, index int64) (agnes.Generation, error) { return generationFor(index), nil }, nil)
		_, err := im.Generate(context.Background(), req, domain.DefaultSettings(), "request")
		var ae *apierror.Error
		if !errors.As(err, &ae) || ae.Status != tc.status || ae.Code == nil || *ae.Code != tc.code {
			t.Fatalf("delivery class lost: %v", err)
		}
		if tasks.Pending() != 0 {
			t.Fatal("total failure reserved enrichment")
		}
	}
}

func TestGenerationWaitsForDelivery(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan *service.ImageResult, 1)
	im, _, req := newDeliveredEnv(t, 1, func(ctx context.Context, in service.DeliveryInput) (service.DeliveredImage, error) {
		close(entered)
		<-release
		return deliveredFor(in), nil
	}, func(ctx context.Context, index int64) (agnes.Generation, error) { return generationFor(index), nil }, nil)
	go func() {
		result, err := im.Generate(context.Background(), req, domain.DefaultSettings(), "request")
		if err != nil {
			t.Error(err)
		}
		done <- result
	}()
	<-entered
	select {
	case <-done:
		t.Fatal("returned before delivery")
	default:
	}
	close(release)
	result := <-done
	if result == nil || len(result.Images) != 1 {
		t.Fatal("missing delivered result")
	}
	result.CancelEnrichment()
}
func TestGenerationDeliveryPartialSuccess(t *testing.T) {
	im, _, req := newDeliveredEnv(t, 3, func(ctx context.Context, in service.DeliveryInput) (service.DeliveredImage, error) {
		if in.SubrequestIndex == 1 {
			return service.DeliveredImage{}, apierror.Coded(503, "persist failed", "server_error", "image_persist_failed")
		}
		return deliveredFor(in), nil
	}, func(ctx context.Context, index int64) (agnes.Generation, error) { return generationFor(index), nil }, nil)
	result, err := im.Generate(context.Background(), req, domain.DefaultSettings(), "request")
	if err != nil {
		t.Fatal(err)
	}
	defer result.CancelEnrichment()
	if len(result.Images) != 2 || result.Images[0].Stored.ID != 1 || result.Images[1].Stored.ID != 21 || result.Headers.Get("X-Agnes-Succeeded") != "2" || result.Headers.Get("X-Agnes-Failed") != "1" {
		t.Fatalf("aggregation: %+v", result)
	}
	if len(result.Log.Attempts) != 3 || !result.Log.Partial || len(result.Log.DeliveryFailures) != 1 {
		t.Fatalf("logs: %+v", result.Log)
	}
}
func TestGenerationMultiOutputPartial(t *testing.T) {
	im, _, req := newDeliveredEnv(t, 1, func(ctx context.Context, in service.DeliveryInput) (service.DeliveredImage, error) {
		if in.ImageIndex == 1 {
			return service.DeliveredImage{}, apierror.Coded(502, "download failed", "server_error", "image_download_failed")
		}
		return deliveredFor(in), nil
	}, func(ctx context.Context, index int64) (agnes.Generation, error) {
		gen := generationFor(index)
		gen.Images = append(gen.Images, gen.Images[0], gen.Images[0])
		return gen, nil
	}, nil)
	result, err := im.Generate(context.Background(), req, domain.DefaultSettings(), "request")
	if err != nil {
		t.Fatal(err)
	}
	defer result.CancelEnrichment()
	if len(result.Images) != 2 || result.Log.Images != 2 || result.Log.Failed != 0 || !result.Log.Partial || !strings.Contains(result.Headers.Get("X-Agnes-Warnings"), "partial-success") || result.Headers.Get("X-Agnes-Succeeded") != "1" {
		t.Fatalf("multi-output: %+v", result)
	}
	failure := result.Log.DeliveryFailures[0]
	if failure.SubrequestIndex != 0 || failure.ImageIndex != 1 || failure.Stage != "download" || failure.Code != "image_download_failed" {
		t.Fatalf("failure: %+v", failure)
	}
}
func TestGenerationCancelAfterSomeSaved(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	jobs := make(chan service.EnrichmentJob, 1)
	im, tasks, req := newDeliveredEnv(t, 1, func(ctx context.Context, in service.DeliveryInput) (service.DeliveredImage, error) {
		cancel()
		return deliveredFor(in), nil
	}, func(ctx context.Context, index int64) (agnes.Generation, error) { return generationFor(index), nil }, func(ctx context.Context, job service.EnrichmentJob) error { jobs <- job; return nil })
	_, err := im.Generate(ctx, req, domain.DefaultSettings(), "request")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	job := <-jobs
	if len(job.IDs) != 1 || job.IDs[0] != 1 {
		t.Fatal("saved ID lost", job)
	}
	if err := tasks.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	if tasks.Pending() != 0 {
		t.Fatal("capacity leaked")
	}
}
func TestEnrichmentHandoffExactlyOnce(t *testing.T) {
	var jobs atomic.Int64
	im, tasks, req := newDeliveredEnv(t, 1, func(ctx context.Context, in service.DeliveryInput) (service.DeliveredImage, error) {
		return deliveredFor(in), nil
	}, func(ctx context.Context, index int64) (agnes.Generation, error) { return generationFor(index), nil }, func(context.Context, service.EnrichmentJob) error { jobs.Add(1); return nil })
	result, err := im.Generate(context.Background(), req, domain.DefaultSettings(), "request")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Go(func() { _ = result.CommitEnrichment() })
		wg.Go(result.CancelEnrichment)
	}
	wg.Wait()
	_ = tasks.Drain(context.Background())
	if jobs.Load() > 1 || tasks.Pending() != 0 {
		t.Fatalf("jobs=%d pending=%d", jobs.Load(), tasks.Pending())
	}
}
func TestGenerationDeliveryConcurrencyBound(t *testing.T) {
	var active, peak atomic.Int64
	release := make(chan struct{})
	entered := make(chan struct{}, 20)
	im, _, req := newDeliveredEnv(t, 4, func(ctx context.Context, in service.DeliveryInput) (service.DeliveredImage, error) {
		current := active.Add(1)
		for {
			old := peak.Load()
			if current <= old || peak.CompareAndSwap(old, current) {
				break
			}
		}
		entered <- struct{}{}
		<-release
		active.Add(-1)
		return deliveredFor(in), nil
	}, func(ctx context.Context, index int64) (agnes.Generation, error) { return generationFor(index), nil }, nil)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Go(func() {
			result, err := im.Generate(context.Background(), req, domain.DefaultSettings(), "request")
			if err != nil {
				t.Error(err)
			} else {
				result.CancelEnrichment()
			}
		})
	}
	<-entered
	<-entered
	close(release)
	wg.Wait()
	if peak.Load() > 2 {
		t.Fatalf("delivery exceeded semaphore: %d", peak.Load())
	}
}
