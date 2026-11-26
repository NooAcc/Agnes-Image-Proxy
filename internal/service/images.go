package service

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

const (
	defaultImageWorkers = 8
	defaultMaxInFlight  = 8
	logRecordTimeout    = 15 * time.Second
)

// SubrequestRunner is one client sub-request through the account pool.
type SubrequestRunner interface {
	Generate(ctx context.Context, req domain.ImageRequest, settings domain.Settings) (agnes.Generation, error)
}

// MeasureRunner measures output images in one batch.
type MeasureRunner interface {
	Measure(ctx context.Context, outputs []domain.OutputImage, settings domain.Settings) ([]domain.Measurement, []string)
}

// RequestLogStore persists request logs and usage.
type RequestLogStore interface {
	RecordRequest(ctx context.Context, log domain.RequestLog) error
}

type MeasurementWriter interface {
	SetImageMeasurement(context.Context, int64, domain.Measurement) error
}

// ImageOptions wires the image orchestration boundaries.
type ImageOptions struct {
	Pool         SubrequestRunner
	Edge         MeasureRunner
	Tasks        *Tasks
	Delivery     DeliveryRunner
	Enrichment   EnrichmentJobRunner
	Measurements MeasurementWriter
	Logs         RequestLogStore
	Context      context.Context
	Workers      int
	MaxInFlight  int
	Now          func() time.Time
	Logf         func(string, ...any)
	// Subrequest is a test-only seam that replaces Pool.Generate while keeping
	// the real scheduler, capacity and enrichment lifecycle.
	Subrequest func(ctx context.Context, index int64) (agnes.Generation, error)
}

// ImageResult couples the response with its headers, log entry and the
// enrichment handoff. Exactly one of CommitEnrichment and CancelEnrichment succeeds.
type ImageResult struct {
	Headers          http.Header
	Log              domain.RequestLog
	Images           []DeliveredImage
	Created          int64
	Size             string
	CommitEnrichment func() error
	CancelEnrichment func()
}

// Images schedules synchronous delivery and one saved-ID enrichment job.
type Images struct {
	pool         SubrequestRunner
	edge         MeasureRunner
	tasks        *Tasks
	delivery     DeliveryRunner
	enrichment   EnrichmentJobRunner
	measurements MeasurementWriter
	logs         RequestLogStore
	subrequest   func(context.Context, int64) (agnes.Generation, error)
	lifetime     context.Context
	workers      int
	sem          chan struct{}
	now          func() time.Time
	logf         func(string, ...any)
}

// NewImages builds the image orchestrator.
func NewImages(options ImageOptions) *Images {
	workers := options.Workers
	if workers < 1 {
		workers = defaultImageWorkers
	}
	maxInFlight := options.MaxInFlight
	if maxInFlight < 1 {
		maxInFlight = defaultMaxInFlight
	}
	lifetime := options.Context
	if lifetime == nil {
		lifetime = context.Background()
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Images{
		pool:         options.Pool,
		edge:         options.Edge,
		tasks:        options.Tasks,
		delivery:     options.Delivery,
		enrichment:   options.Enrichment,
		measurements: options.Measurements,
		logs:         options.Logs,
		subrequest:   options.Subrequest,
		lifetime:     lifetime,
		workers:      workers,
		sem:          make(chan struct{}, maxInFlight),
		now:          now,
		logf:         options.Logf,
	}
}

// Generate runs every sub-request with bounded concurrency, measures the
// aggregate output once, and hands saved image IDs to one enrichment job.
func (im *Images) Generate(ctx context.Context, req domain.ImageRequest, settings domain.Settings, requestID string) (*ImageResult, error) {
	return im.generateDelivered(ctx, req, settings, requestID)
}

func (im *Images) runSubrequest(ctx context.Context, req domain.ImageRequest, settings domain.Settings, index int64) (agnes.Generation, error) {
	if im.subrequest != nil {
		return im.subrequest(ctx, index)
	}
	if im.pool == nil {
		return agnes.Generation{}, errors.New("no image pool configured")
	}
	return im.pool.Generate(ctx, req, settings)
}

func (im *Images) measure(ctx context.Context, outputs []domain.OutputImage, settings domain.Settings) ([]domain.Measurement, []string) {
	if im.edge == nil || len(outputs) == 0 {
		return make([]domain.Measurement, len(outputs)), nil
	}
	return im.edge.Measure(ctx, outputs, settings)
}

func (im *Images) acquire(ctx context.Context) error {
	select {
	case im.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (im *Images) release() { <-im.sem }

type aggregatedFailure struct {
	err    error
	status int
}

// aggregate applies the Task 5 priority (429 > 504 > 502 > 503).
func (im *Images) aggregate(failures map[int64]error, n int64) aggregatedFailure {
	errs := make([]error, 0, len(failures))
	for _, index := range sortedIndexes(failures) {
		errs = append(errs, failures[index])
	}
	var validation error
	for _, failure := range errs {
		var ae *apierror.Error
		if errors.As(failure, &ae) && (ae.Status == 400 || ae.Status == 404) {
			if validation == nil {
				validation = failure
			}
		} else {
			validation = nil
			break
		}
	}
	// Preserve ordered validation errors when every executed request was rejected;
	// mixed gateway failures still use the documented fixed priority.
	if validation != nil {
		return aggregatedFailure{err: validation, status: failureStatusOf(validation)}
	}
	err := selectDeliveryFailure(errs, im.now())
	return aggregatedFailure{err: err, status: failureStatusOf(err)}
}

func (im *Images) failureLog(started time.Time, req domain.ImageRequest, requestID string, status int, generations map[int64]agnes.Generation, failures map[int64]error) domain.RequestLog {
	attempts := make([]domain.Attempt, 0)
	for _, index := range sortedIndexes(generations) {
		attempts = append(attempts, generations[index].Attempts...)
	}
	return domain.RequestLog{
		RequestID:   requestID,
		APIKeyName:  req.APIKeyName,
		TS:          started.UTC(),
		Category:    "request",
		Stage:       "complete",
		Endpoint:    req.Endpoint,
		Model:       req.Model,
		Status:      status,
		OK:          false,
		Requested:   int(req.N),
		Images:      0,
		Failed:      int(req.N),
		DurationMS:  im.now().Sub(started).Milliseconds(),
		SizeRequest: strPtr(images.FormatRequestSize(req.Size)),
		Attempts:    attempts,
	}
}

func (im *Images) record(log domain.RequestLog) {
	base := context.WithoutCancel(im.lifetime)
	ctx, cancel := context.WithTimeout(base, logRecordTimeout)
	defer cancel()
	if im.logs == nil {
		return
	}
	if err := im.logs.RecordRequest(ctx, log); err != nil {
		im.logError("request log failed: %v", err)
	}
}

func (im *Images) logError(format string, args ...any) {
	if im.logf != nil {
		im.logf(format, args...)
	}
}

func selectDeliveryFailure(errs []error, now time.Time) error {
	aggregated := agnes.SelectFailure(errs, now)
	status := failureStatusOf(aggregated)
	for _, err := range errs {
		var ae *apierror.Error
		if errors.As(err, &ae) && ae.Status == status && ae.Code != nil && strings.HasPrefix(*ae.Code, "image_") {
			return err
		}
	}
	return aggregated
}

func failureStatusOf(err error) int {
	var apiErr *apierror.Error
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	return 502
}

func appendUniqueStatus(values []int, status int) []int {
	for _, value := range values {
		if value == status {
			return values
		}
	}
	return append(values, status)
}

func appendUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func sortedIndexes[T any](values map[int64]T) []int64 {
	indexes := make([]int64, 0, len(values))
	for index := range values {
		indexes = append(indexes, index)
	}
	sort.Slice(indexes, func(i, j int) bool { return indexes[i] < indexes[j] })
	return indexes
}

func strPtr(value string) *string { return &value }
