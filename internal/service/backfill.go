package service

import (
	"context"
	"sync"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const backfillBatch = 20

// BackfillStore is the persistence boundary for the backfill pass.
type BackfillStore interface {
	PendingEnrichment(ctx context.Context, before *int64, limit int) ([]domain.GallerySource, error)
	GalleryEnrichState(ctx context.Context, id int64) (string, domain.GallerySource, bool, error)
	RecordEnrichment(ctx context.Context, log domain.RequestLog) error
}

// BackfillOptions wires the manual backfill pass.
type BackfillOptions struct {
	Store    BackfillStore
	Enricher Enricher
	Settings func(context.Context) (domain.Settings, error)
	Locks    *GalleryLocks
}

// BackfillStatus is a concurrent snapshot of the single backfill pass.
type BackfillStatus struct {
	Running    bool       `json:"running"`
	StartedAt  *time.Time `json:"startedAt"`
	FinishedAt *time.Time `json:"finishedAt"`
	Processed  int        `json:"processed"`
	Succeeded  int        `json:"succeeded"`
	Failed     int        `json:"failed"`
	Error      *string    `json:"error"`
}

// Backfill runs one snapshot traversal of pending or failed enrichment rows.
type Backfill struct {
	store    BackfillStore
	enricher Enricher
	settings func(context.Context) (domain.Settings, error)
	locks    *GalleryLocks

	mu     sync.Mutex
	status BackfillStatus
	cancel context.CancelFunc
	done   chan struct{}
}

// NewBackfill builds the backfill runner.
func NewBackfill(options BackfillOptions) *Backfill {
	locks := options.Locks
	if locks == nil {
		locks = NewGalleryLocks()
	}
	return &Backfill{
		store:    options.Store,
		enricher: options.Enricher,
		settings: options.Settings,
		locks:    locks,
	}
}

// Start begins a pass and returns immediately. It rejects a second concurrent
// pass with 409 and a pass with no image service with 400.
func (b *Backfill) Start(ctx context.Context) (BackfillStatus, error) {
	b.mu.Lock()
	if b.status.Running {
		status := b.status
		b.mu.Unlock()
		return status, apierror.Coded(409, "enrichment backfill is already running", "invalid_request_error", "enrichment_running")
	}
	b.mu.Unlock()

	settings, err := b.settings(ctx)
	if err != nil {
		return b.Status(), err
	}
	if settings.ImageServiceBaseURL == "" {
		return b.Status(), apierror.Coded(400, "image service is not configured", "invalid_request_error", "image_service_disabled")
	}

	// Capture the snapshot ceiling before returning so rows created after Start
	// are never part of this pass.
	newest, err := b.store.PendingEnrichment(ctx, nil, 1)
	if err != nil {
		return b.Status(), err
	}
	var ceiling *int64
	if len(newest) > 0 {
		limit := newest[0].ID + 1
		ceiling = &limit
	}

	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	done := make(chan struct{})

	b.mu.Lock()
	if b.status.Running {
		b.mu.Unlock()
		cancel()
		return b.Status(), apierror.Coded(409, "enrichment backfill is already running", "invalid_request_error", "enrichment_running")
	}
	started := time.Now().UTC()
	b.status = BackfillStatus{Running: true, StartedAt: &started}
	b.cancel = cancel
	b.done = done
	status := b.status
	b.mu.Unlock()

	go b.run(runCtx, ceiling, settings, done)
	return status, nil
}

// Status returns a consistent snapshot of the pass state.
func (b *Backfill) Status() BackfillStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.status
}

// Stop cancels a running pass and waits for it, bounded by ctx.
func (b *Backfill) Stop(ctx context.Context) error {
	b.mu.Lock()
	cancel := b.cancel
	done := b.done
	b.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *Backfill) run(ctx context.Context, ceiling *int64, settings domain.Settings, done chan struct{}) {
	defer func() {
		finished := time.Now().UTC()
		b.mu.Lock()
		b.status.Running = false
		b.status.FinishedAt = &finished
		b.mu.Unlock()
		close(done)
	}()

	processed, succeeded, failed := 0, 0, 0
	cursor := ceiling
	for cursor != nil && ctx.Err() == nil {
		rows, err := b.store.PendingEnrichment(ctx, cursor, backfillBatch)
		if err != nil {
			b.setError(err)
			return
		}
		if len(rows) == 0 {
			break
		}
		for _, row := range rows {
			if ctx.Err() != nil {
				return
			}
			report, ok := b.processRow(ctx, row.ID, settings)
			if !ok {
				continue
			}
			processed += report.Processed
			succeeded += report.Succeeded
			failed += report.Failed
		}
		last := rows[len(rows)-1].ID
		cursor = &last
		b.setProgress(processed, succeeded, failed)
	}

	if processed == 0 {
		return
	}
	log := domain.RequestLog{
		TS:        time.Now().UTC(),
		Category:  "enrich",
		Stage:     "backfill",
		Status:    200,
		Requested: processed,
		Images:    succeeded,
		Failed:    failed,
	}
	if err := b.store.RecordEnrichment(context.WithoutCancel(ctx), log); err != nil {
		b.setError(err)
	}
}

// processRow re-reads the row under the shared per-gallery lock so completed or
// deleted rows are never enriched twice.
func (b *Backfill) processRow(ctx context.Context, id int64, settings domain.Settings) (EnrichReport, bool) {
	unlock := b.locks.Lock(id)
	defer unlock()

	status, source, found, err := b.store.GalleryEnrichState(ctx, id)
	if err != nil {
		return EnrichReport{}, false
	}
	if !found || (status != "pending" && status != "failed") {
		return EnrichReport{}, false
	}
	report, err := b.enricher.Enrich(ctx, []domain.GallerySource{source}, settings)
	if err != nil || ctx.Err() != nil {
		return EnrichReport{}, false
	}
	return report, true
}

func (b *Backfill) setProgress(processed, succeeded, failed int) {
	b.mu.Lock()
	b.status.Processed = processed
	b.status.Succeeded = succeeded
	b.status.Failed = failed
	b.mu.Unlock()
}

func (b *Backfill) setError(err error) {
	message := err.Error()
	b.mu.Lock()
	b.status.Error = &message
	b.mu.Unlock()
}
