package service

import (
	"context"
	"errors"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

type EnrichmentJob struct {
	RequestID, Endpoint, Model string
	IDs                        []int64
	Settings                   domain.Settings
}
type EnrichmentJobRunner interface {
	Run(context.Context, EnrichmentJob) error
}
type EnrichmentJobStore interface {
	GalleryEnrichState(context.Context, int64) (string, domain.GallerySource, bool, error)
	RecordEnrichment(context.Context, domain.RequestLog) error
}
type EnrichmentJobs struct{ options EnrichmentJobOptions }

func NewEnrichmentJobs(options EnrichmentJobOptions) *EnrichmentJobs {
	if options.Locks == nil {
		options.Locks = NewGalleryLocks()
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &EnrichmentJobs{options: options}
}
func (j *EnrichmentJobs) Run(ctx context.Context, job EnrichmentJob) error {
	if job.Settings.ImageServiceBaseURL == "" || j.options.Enricher == nil {
		return nil
	}
	var combined EnrichReport
	var errs []error
	for _, id := range job.IDs {
		if ctx.Err() != nil {
			break
		}
		func() {
			unlock := j.options.Locks.Lock(id)
			defer unlock()
			status, source, found, err := j.options.Store.GalleryEnrichState(ctx, id)
			if err != nil {
				errs = append(errs, err)
				return
			}
			if !found || (status != "pending" && status != "failed") {
				return
			}
			report, err := j.options.Enricher.Enrich(ctx, []domain.GallerySource{source}, job.Settings)
			combined.Processed += report.Processed
			combined.Succeeded += report.Succeeded
			combined.Failed += report.Failed
			if err != nil {
				errs = append(errs, err)
			}
		}()
	}
	if combined.Processed > 0 {
		logCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), logRecordTimeout)
		defer cancel()
		err := j.options.Store.RecordEnrichment(logCtx, domain.RequestLog{RequestID: job.RequestID, Endpoint: job.Endpoint, Model: job.Model, TS: j.options.Now().UTC(), Category: "enrich", Stage: "enrichment", Status: 200, Requested: combined.Processed, Images: combined.Succeeded, Failed: combined.Failed})
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

type EnrichmentJobOptions struct {
	Store    EnrichmentJobStore
	Enricher Enricher
	Locks    *GalleryLocks
	Now      func() time.Time
	Logf     func(string, ...any)
}
