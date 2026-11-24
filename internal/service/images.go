package service

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

// ArchiveRunner persists a completed request's images.
type ArchiveRunner interface {
	Run(ctx context.Context, job ArchiveJob) error
}

// RequestLogStore persists request logs and usage.
type RequestLogStore interface {
	RecordRequest(ctx context.Context, log domain.RequestLog) error
}

// ImageOptions wires the image orchestration boundaries.
type ImageOptions struct {
	Pool        SubrequestRunner
	Edge        MeasureRunner
	Tasks       *Tasks
	Archiver    ArchiveRunner
	Logs        RequestLogStore
	Context     context.Context
	Workers     int
	MaxInFlight int
	Now         func() time.Time
	Logf        func(string, ...any)
	// Subrequest is a test-only seam that replaces Pool.Generate while keeping
	// the real scheduler, capacity and archive lifecycle.
	Subrequest func(ctx context.Context, index int64) (agnes.Generation, error)
}

// ImageResponse is the OpenAI images response body.
type ImageResponse struct {
	Created      int64               `json:"created"`
	Data         []ImageResponseItem `json:"data"`
	Size         string              `json:"size"`
	OutputFormat *string             `json:"output_format,omitempty"`
}

// ImageResponseItem is one returned image.
type ImageResponseItem struct {
	URL           *string `json:"url"`
	B64JSON       *string `json:"b64_json"`
	RevisedPrompt *string `json:"revised_prompt"`
}

// ImageResult couples the response with its headers, log entry and the
// archive handoff. Exactly one of CommitArchive and CancelArchive succeeds.
type ImageResult struct {
	Response      ImageResponse
	Headers       http.Header
	Log           domain.RequestLog
	CommitArchive func() error
	CancelArchive func()
}

// Images schedules client sub-requests and commits one archive job.
type Images struct {
	pool       SubrequestRunner
	edge       MeasureRunner
	tasks      *Tasks
	archiver   ArchiveRunner
	logs       RequestLogStore
	subrequest func(context.Context, int64) (agnes.Generation, error)
	lifetime   context.Context
	workers    int
	sem        chan struct{}
	now        func() time.Time
	logf       func(string, ...any)
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
		pool:       options.Pool,
		edge:       options.Edge,
		tasks:      options.Tasks,
		archiver:   options.Archiver,
		logs:       options.Logs,
		subrequest: options.Subrequest,
		lifetime:   lifetime,
		workers:    workers,
		sem:        make(chan struct{}, maxInFlight),
		now:        now,
		logf:       options.Logf,
	}
}

// Generate runs every sub-request with bounded concurrency, measures the
// aggregate output once, and hands all successful images to one archive job.
func (im *Images) Generate(ctx context.Context, req domain.ImageRequest, settings domain.Settings, requestID string) (*ImageResult, error) {
	started := im.now()
	reservation, err := im.tasks.Reserve(ctx)
	if err != nil {
		return nil, apierror.Coded(503, "service is not accepting requests", "server_error", "service_unavailable")
	}

	n := req.N
	if n < 0 {
		n = 0
	}
	workers := im.workers
	if int64(workers) > n {
		workers = int(n)
	}

	var next atomic.Int64
	var mu sync.Mutex
	generations := make(map[int64]agnes.Generation)
	failures := make(map[int64]error)
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				index := next.Add(1) - 1
				if index >= n || ctx.Err() != nil {
					return
				}
				if err := im.acquire(ctx); err != nil {
					return
				}
				generation, genErr := im.runSubrequest(ctx, req, settings, index)
				im.release()
				if genErr != nil && ctx.Err() != nil {
					return
				}
				mu.Lock()
				generations[index] = generation
				if genErr != nil {
					failures[index] = genErr
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	successes := make([]int64, 0, len(generations))
	for index := range generations {
		if _, failed := failures[index]; !failed {
			successes = append(successes, index)
		}
	}
	sort.Slice(successes, func(i, j int) bool { return successes[i] < successes[j] })

	if len(successes) == 0 {
		reservation.Release()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		aggregated := im.aggregate(failures, n)
		im.record(im.failureLog(started, req, requestID, aggregated.status, generations, failures))
		return nil, aggregated.err
	}

	attempts := make([]domain.Attempt, 0)
	failedStatuses := make([]int, 0)
	for _, index := range sortedIndexes(generations) {
		generation := generations[index]
		attempts = append(attempts, generation.Attempts...)
		if _, failed := failures[index]; failed {
			failedStatuses = appendUniqueStatus(failedStatuses, failureStatusOf(failures[index]))
		}
	}

	outputs := make([]domain.OutputImage, 0)
	for _, index := range successes {
		outputs = append(outputs, generations[index].Images...)
	}
	measurements, measureWarnings := im.measure(ctx, outputs, settings)

	data := make([]ImageResponseItem, 0, len(outputs))
	generated := make([]domain.GeneratedImage, 0, len(outputs))
	imageIndex := 0
	var uniqueSizes []string
	var firstSize *domain.PixelSize
	for _, index := range successes {
		generation := generations[index]
		for _, output := range generation.Images {
			var measurement domain.Measurement
			if imageIndex < len(measurements) {
				measurement = measurements[imageIndex]
			}
			if measurement.Size != nil {
				uniqueSizes = appendUniqueString(uniqueSizes, images.FormatPixel(*measurement.Size))
				if firstSize == nil {
					size := *measurement.Size
					firstSize = &size
				}
			}
			data = append(data, ImageResponseItem{URL: output.URL, B64JSON: output.Base64})
			generated = append(generated, domain.GeneratedImage{
				Image:       output,
				Measurement: measurement,
				AccountID:   generation.AccountID,
				AccountName: generation.AccountName,
			})
			imageIndex++
		}
	}

	size := images.FormatPixel(req.Size.Expected)
	if firstSize != nil {
		size = images.FormatPixel(*firstSize)
	}
	warnings := append([]string(nil), req.Warnings...)
	for _, warning := range measureWarnings {
		warnings = appendUniqueString(warnings, warning)
	}
	if len(failures) > 0 {
		warnings = appendUniqueString(warnings, "partial-success")
	}

	headers := http.Header{}
	headers.Set("X-Agnes-Requested", strconv.FormatInt(n, 10))
	headers.Set("X-Agnes-Succeeded", strconv.Itoa(len(successes)))
	headers.Set("X-Agnes-Failed", strconv.Itoa(int(n)-len(successes)))
	headers.Set("X-Agnes-Resolved-Size", images.FormatRequestSize(req.Size))
	if len(failedStatuses) > 0 {
		statuses := make([]string, 0, len(failedStatuses))
		for _, status := range failedStatuses {
			statuses = append(statuses, strconv.Itoa(status))
		}
		headers.Set("X-Agnes-Failure-Statuses", strings.Join(statuses, ","))
	}
	if len(warnings) > 0 {
		headers.Set("X-Agnes-Warnings", strings.Join(warnings, ","))
	}

	log := domain.RequestLog{
		RequestID:   requestID,
		TS:          started.UTC(),
		Category:    "request",
		Stage:       "complete",
		Endpoint:    req.Endpoint,
		Model:       req.Model,
		Status:      200,
		OK:          len(failures) == 0,
		Requested:   int(n),
		Images:      len(data),
		Failed:      int(n) - len(successes),
		DurationMS:  im.now().Sub(started).Milliseconds(),
		SizeRequest: strPtr(images.FormatRequestSize(req.Size)),
		Attempts:    attempts,
	}
	if len(uniqueSizes) > 0 {
		log.SizeActual = strPtr(strings.Join(uniqueSizes, ","))
	}
	im.record(log)

	result := &ImageResult{
		Response: ImageResponse{Created: im.now().Unix(), Data: data, Size: size},
		Headers:  headers,
		Log:      log,
	}
	job := ArchiveJob{
		RequestID:    requestID,
		Endpoint:     req.Endpoint,
		Model:        req.Model,
		Prompt:       req.Prompt,
		ExpectedSize: images.FormatRequestSize(req.Size),
		Images:       generated,
		Settings:     settings,
	}
	var once sync.Mutex
	used := false
	result.CommitArchive = func() error {
		once.Lock()
		defer once.Unlock()
		if used {
			return ErrReservationUsed
		}
		used = true
		archiver := im.archiver
		if archiver == nil {
			reservation.Release()
			return nil
		}
		err := reservation.Submit(func(taskCtx context.Context) {
			if runErr := archiver.Run(taskCtx, job); runErr != nil {
				im.logError("archive failed: %v", runErr)
			}
		})
		if err != nil {
			reservation.Release()
		}
		return err
	}
	result.CancelArchive = func() {
		once.Lock()
		defer once.Unlock()
		if used {
			return
		}
		used = true
		reservation.Release()
	}
	return result, nil
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
	err := agnes.SelectFailure(errs, im.now())
	return aggregatedFailure{err: err, status: failureStatusOf(err)}
}

func (im *Images) failureLog(started time.Time, req domain.ImageRequest, requestID string, status int, generations map[int64]agnes.Generation, failures map[int64]error) domain.RequestLog {
	attempts := make([]domain.Attempt, 0)
	for _, index := range sortedIndexes(generations) {
		attempts = append(attempts, generations[index].Attempts...)
	}
	return domain.RequestLog{
		RequestID:   requestID,
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
