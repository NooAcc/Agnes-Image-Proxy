package service

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

func (im *Images) generateDelivered(ctx context.Context, req domain.ImageRequest, settings domain.Settings, requestID string) (*ImageResult, error) {
	started := im.now()
	reservation, err := im.tasks.Reserve(ctx)
	if err != nil {
		return nil, apierror.Coded(503, "service is not accepting requests", "server_error", "service_unavailable")
	}
	handedOff := false
	defer func() {
		if !handedOff {
			reservation.Release()
		}
	}()
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
	generations := map[int64]agnes.Generation{}
	delivered := map[int64][]DeliveredImage{}
	failures := map[int64]error{}
	stages := map[int64][]domain.DeliveryFailure{}
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Go(func() {
			for {
				index := next.Add(1) - 1
				if index >= n || ctx.Err() != nil {
					return
				}
				if err := im.acquire(ctx); err != nil {
					return
				}
				func() {
					defer im.release()
					generation, genErr := im.runSubrequest(ctx, req, settings, index)
					var saved []DeliveredImage
					var stageFailures []domain.DeliveryFailure
					var outputErrors []error
					if genErr == nil {
						for imageIndex, output := range generation.Images {
							if ctx.Err() != nil {
								break
							}
							source := ""
							if output.URL != nil {
								source = *output.URL
							}
							image, err := im.delivery.Deliver(ctx, DeliveryInput{RequestID: requestID, SubrequestIndex: index, ImageIndex: imageIndex, Model: req.Model, Prompt: req.Prompt, ExpectedSize: images.FormatRequestSize(req.Size), SourceURL: source, AccountID: generation.AccountID, AccountName: generation.AccountName, IncludeBase64: req.ResponseFormat == "b64_json"})
							if err == nil {
								saved = append(saved, image)
								continue
							}
							outputErrors = append(outputErrors, err)
							status := failureStatusOf(err)
							code := "image_download_failed"
							stage := "download"
							var ae *apierror.Error
							if errors.As(err, &ae) && ae.Code != nil {
								code = *ae.Code
							}
							if code == "image_persist_failed" {
								stage = "persist"
							}
							stageFailures = append(stageFailures, domain.DeliveryFailure{SubrequestIndex: index, ImageIndex: imageIndex, Stage: stage, Status: status, Code: code})
						}
						if len(saved) == 0 {
							if len(outputErrors) == 0 {
								genErr = apierror.Coded(502, "no images were delivered", "server_error", "image_download_failed")
							} else {
								genErr = selectDeliveryFailure(outputErrors, im.now())
							}
						}
					}
					mu.Lock()
					generations[index] = generation
					delivered[index] = saved
					stages[index] = stageFailures
					if genErr != nil {
						failures[index] = genErr
					}
					mu.Unlock()
				}()
			}
		})
	}
	wg.Wait()
	var resultImages []DeliveredImage
	var deliveryFailures []domain.DeliveryFailure
	var attempts []domain.Attempt
	var succeeded int
	var statusList []int
	for _, index := range sortedIndexes(generations) {
		attempts = append(attempts, generations[index].Attempts...)
		if len(delivered[index]) > 0 {
			succeeded++
		}
		resultImages = append(resultImages, delivered[index]...)
		deliveryFailures = append(deliveryFailures, stages[index]...)
		if err := failures[index]; err != nil {
			statusList = appendUniqueStatus(statusList, failureStatusOf(err))
		}
		for _, failure := range stages[index] {
			statusList = appendUniqueStatus(statusList, failure.Status)
		}
	}
	ids := make([]int64, 0, len(resultImages))
	for _, image := range resultImages {
		ids = append(ids, image.Stored.ID)
	}
	commit, cancel := im.enrichmentHandoff(reservation, EnrichmentJob{RequestID: requestID, Endpoint: req.Endpoint, Model: req.Model, IDs: ids, Settings: settings})
	recordCancellation := func() bool {
		if ctx.Err() == nil {
			return false
		}
		if len(ids) > 0 {
			_ = commit()
			handedOff = true
		}
		log := im.failureLog(started, req, requestID, 499, generations, failures)
		log.Images = len(resultImages)
		log.Failed = int(n) - succeeded
		log.Partial = len(resultImages) > 0
		log.DeliveryFailures = deliveryFailures
		im.record(log)
		return true
	}
	if recordCancellation() {
		return nil, ctx.Err()
	}
	if len(resultImages) == 0 {
		aggregated := im.aggregate(failures, n)
		log := im.failureLog(started, req, requestID, aggregated.status, generations, failures)
		log.DeliveryFailures = deliveryFailures
		im.record(log)
		return nil, aggregated.err
	}
	outputs := make([]domain.OutputImage, len(resultImages))
	for i := range resultImages {
		outputs[i].URL = &resultImages[i].SourceURL
	}
	measurements, measureWarnings := im.measure(ctx, outputs, settings)
	size := images.FormatPixel(req.Size.Expected)
	var uniqueSizes []string
	firstSize := true
	for i := range resultImages {
		if i >= len(measurements) {
			break
		}
		measurement := measurements[i]
		resultImages[i].Measurement = measurement
		if measurement.Size != nil {
			actual := images.FormatPixel(*measurement.Size)
			uniqueSizes = appendUniqueString(uniqueSizes, actual)
			if firstSize {
				size = actual
				firstSize = false
			}
		}
		if im.measurements != nil && (measurement.Size != nil || measurement.Format != nil) {
			if err := im.measurements.SetImageMeasurement(ctx, resultImages[i].Stored.ID, measurement); err != nil {
				measureWarnings = appendUniqueString(measureWarnings, "size-measure-failed")
			}
		}
	}
	if recordCancellation() {
		return nil, ctx.Err()
	}
	partial := succeeded < int(n) || len(deliveryFailures) > 0
	warnings := append([]string(nil), req.Warnings...)
	for _, warning := range measureWarnings {
		warnings = appendUniqueString(warnings, warning)
	}
	if partial {
		warnings = appendUniqueString(warnings, "partial-success")
	}
	headers := http.Header{}
	headers.Set("X-Agnes-Requested", strconv.FormatInt(n, 10))
	headers.Set("X-Agnes-Succeeded", strconv.Itoa(succeeded))
	headers.Set("X-Agnes-Failed", strconv.Itoa(int(n)-succeeded))
	headers.Set("X-Agnes-Resolved-Size", images.FormatRequestSize(req.Size))
	if len(statusList) > 0 {
		values := make([]string, len(statusList))
		for i, status := range statusList {
			values[i] = strconv.Itoa(status)
		}
		headers.Set("X-Agnes-Failure-Statuses", strings.Join(values, ","))
	}
	if len(warnings) > 0 {
		headers.Set("X-Agnes-Warnings", strings.Join(warnings, ","))
	}
	log := domain.RequestLog{RequestID: requestID, TS: started.UTC(), Category: "request", Stage: "complete", Endpoint: req.Endpoint, Model: req.Model, Status: 200, OK: true, Requested: int(n), Images: len(resultImages), Failed: int(n) - succeeded, Partial: partial, DeliveryFailures: deliveryFailures, Attempts: attempts, DurationMS: im.now().Sub(started).Milliseconds(), SizeRequest: strPtr(images.FormatRequestSize(req.Size))}
	if len(uniqueSizes) > 0 {
		log.SizeActual = strPtr(strings.Join(uniqueSizes, ","))
	}
	im.record(log)
	result := &ImageResult{Images: resultImages, Created: im.now().Unix(), Size: size, Headers: headers, Log: log, CommitEnrichment: commit, CancelEnrichment: cancel}
	handedOff = true
	return result, nil
}
func (im *Images) enrichmentHandoff(reservation *Reservation, job EnrichmentJob) (func() error, func()) {
	var mu sync.Mutex
	used := false
	commit := func() error {
		mu.Lock()
		defer mu.Unlock()
		if used {
			return ErrReservationUsed
		}
		used = true
		if im.enrichment == nil || len(job.IDs) == 0 {
			reservation.Release()
			return nil
		}
		err := reservation.Submit(func(ctx context.Context) {
			if err := im.enrichment.Run(ctx, job); err != nil {
				im.logError("enrichment failed")
			}
		})
		if err != nil {
			reservation.Release()
		}
		return err
	}
	cancel := func() {
		mu.Lock()
		defer mu.Unlock()
		if used {
			return
		}
		used = true
		reservation.Release()
	}
	return commit, cancel
}
