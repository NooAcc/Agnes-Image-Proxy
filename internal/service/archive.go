package service

import (
	"context"
	"encoding/base64"
	"errors"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

// Downloader fetches an output image for archiving.
type Downloader interface {
	Download(ctx context.Context, url string) ([]byte, string, error)
}

// Enricher runs thumbnail and NSFW enrichment.
type Enricher interface {
	Enrich(ctx context.Context, sources []domain.GallerySource, settings domain.Settings) (EnrichReport, error)
}

// ArchiveStore is the persistence boundary for archiving.
type ArchiveStore interface {
	InsertGallery(ctx context.Context, insert domain.GalleryInsert) (int64, error)
	RecordEnrichment(ctx context.Context, log domain.RequestLog) error
}

// ArchiveJob carries the request snapshot and every successful output image.
type ArchiveJob struct {
	RequestID    string
	Endpoint     string
	Model        string
	Prompt       string
	ExpectedSize string
	Images       []domain.GeneratedImage
	Settings     domain.Settings
}

// ArchiverOptions wires the archiver boundaries.
type ArchiverOptions struct {
	Store      ArchiveStore
	Downloader Downloader
	Enricher   Enricher
	Locks      *GalleryLocks
	Now        func() time.Time
	Logf       func(format string, args ...any)
}

// Archiver persists generated images and runs automatic enrichment.
type Archiver struct {
	store      ArchiveStore
	downloader Downloader
	enricher   Enricher
	locks      *GalleryLocks
	now        func() time.Time
	logf       func(string, ...any)
}

// NewArchiver builds the archiver.
func NewArchiver(options ArchiverOptions) *Archiver {
	locks := options.Locks
	if locks == nil {
		locks = NewGalleryLocks()
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Archiver{
		store:      options.Store,
		downloader: options.Downloader,
		enricher:   options.Enricher,
		locks:      locks,
		now:        now,
		logf:       options.Logf,
	}
}

// Run archives every image and then enriches rows when the image service is
// configured. Download failures keep the source URL and do not fail the run.
func (a *Archiver) Run(ctx context.Context, job ArchiveJob) error {
	var (
		errs           []error
		enrichedRows   int
		enrichedOK     int
		enrichedFailed int
	)
	enrichEnabled := job.Settings.ImageServiceBaseURL != "" && a.enricher != nil

	for _, image := range job.Images {
		data, mime := a.materialize(ctx, image)

		insert := domain.GalleryInsert{
			RequestID:   job.RequestID,
			Model:       job.Model,
			Prompt:      job.Prompt,
			SizeRequest: job.ExpectedSize,
			AccountName: image.AccountName,
			SourceURL:   image.Image.URL,
			Image:       data,
			ImageMIME:   mimePtr(mime),
		}
		if image.AccountID > 0 {
			accountID := image.AccountID
			insert.AccountID = &accountID
		}
		if image.Measurement.Size != nil {
			actual := images.FormatPixel(*image.Measurement.Size)
			insert.SizeActual = &actual
		}
		if len(data) > 0 {
			sourceMIME := mime
			sourceBytes := int64(len(data))
			insert.SourceMIME = &sourceMIME
			insert.SourceBytes = &sourceBytes
		}

		id, err := a.store.InsertGallery(ctx, insert)
		if err != nil && len(data) > 0 {
			// Retry as a metadata row; the bytes stay available for
			// base64 enrichment.
			insert.Image = nil
			insert.ImageMIME = nil
			id, err = a.store.InsertGallery(ctx, insert)
		}
		if err != nil {
			errs = append(errs, err)
			a.logError("archive insert failed: %v", err)
			continue
		}

		if !enrichEnabled || (len(data) == 0 && image.Image.URL == nil) {
			continue
		}
		source := domain.GallerySource{
			ID:          id,
			SourceURL:   image.Image.URL,
			MIME:        mime,
			Bytes:       int64(len(data)),
			SourceBytes: int64(len(data)),
			HasImage:    len(data) > 0,
			Data:        data,
		}
		report, enrichErr := a.enrichLocked(ctx, id, source, job.Settings)
		if enrichErr != nil {
			errs = append(errs, enrichErr)
		}
		enrichedRows += report.Processed
		enrichedOK += report.Succeeded
		enrichedFailed += report.Failed
	}

	if enrichedRows > 0 {
		enrichLog := domain.RequestLog{
			RequestID: job.RequestID,
			TS:        a.now().UTC(),
			Category:  "enrich",
			Stage:     "archive",
			Endpoint:  job.Endpoint,
			Model:     job.Model,
			Status:    200,
			Requested: enrichedRows,
			Images:    enrichedOK,
			Failed:    enrichedFailed,
		}
		if err := a.store.RecordEnrichment(ctx, enrichLog); err != nil {
			errs = append(errs, err)
			a.logError("archive enrich log failed: %v", err)
		}
	}
	return errors.Join(errs...)
}

func (a *Archiver) enrichLocked(ctx context.Context, id int64, source domain.GallerySource, settings domain.Settings) (EnrichReport, error) {
	unlock := a.locks.Lock(id)
	defer unlock()
	return a.enricher.Enrich(ctx, []domain.GallerySource{source}, settings)
}

func (a *Archiver) materialize(ctx context.Context, image domain.GeneratedImage) ([]byte, string) {
	if image.Image.Base64 != nil && *image.Image.Base64 != "" {
		decoded, err := base64.StdEncoding.DecodeString(*image.Image.Base64)
		if err == nil {
			if mime := images.SniffImage(decoded); mime != "" {
				return decoded, mime
			}
		}
		return nil, ""
	}
	if image.Image.URL != nil && *image.Image.URL != "" && a.downloader != nil {
		data, _, err := a.downloader.Download(ctx, *image.Image.URL)
		if err != nil || len(data) == 0 {
			return nil, ""
		}
		if sniffed := images.SniffImage(data); sniffed != "" {
			return data, sniffed
		}
		return nil, ""
	}
	return nil, ""
}

func mimePtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (a *Archiver) logError(format string, args ...any) {
	if a.logf != nil {
		a.logf(format, args...)
	}
}
