package service_test

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

type fakeRow struct {
	status  string
	source  domain.GallerySource
	deleted bool
}

type fakeBackfillStore struct {
	mu           sync.Mutex
	rows         map[int64]*fakeRow
	logs         []domain.RequestLog
	pendingCalls int
	writes       int
}

func newFakeBackfillStore(rows map[int64]*fakeRow) *fakeBackfillStore {
	return &fakeBackfillStore{rows: rows}
}

func (f *fakeBackfillStore) PendingEnrichment(_ context.Context, before *int64, limit int) ([]domain.GallerySource, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pendingCalls++
	var ids []int64
	for id, row := range f.rows {
		if row.deleted || (row.status != "pending" && row.status != "failed") {
			continue
		}
		if before != nil && id >= *before {
			continue
		}
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] > ids[j] })
	if len(ids) > limit {
		ids = ids[:limit]
	}
	out := make([]domain.GallerySource, 0, len(ids))
	for _, id := range ids {
		source := f.rows[id].source
		source.ID = id
		out = append(out, source)
	}
	return out, nil
}

func (f *fakeBackfillStore) GalleryEnrichState(_ context.Context, id int64) (string, domain.GallerySource, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.rows[id]
	if !ok || row.deleted {
		return "", domain.GallerySource{}, false, nil
	}
	source := row.source
	source.ID = id
	return row.status, source, true, nil
}

func (f *fakeBackfillStore) GalleryContent(_ context.Context, id int64, _ bool) ([]byte, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.rows[id]
	if !ok || len(row.source.Data) == 0 {
		return nil, "", apierror.Coded(404, "image content not found", "invalid_request_error", "not_found")
	}
	return row.source.Data, "image/png", nil
}

func (f *fakeBackfillStore) SetEnrichment(_ context.Context, id int64, write domain.EnrichmentWrite) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	if row, ok := f.rows[id]; ok {
		row.status = write.Status
	}
	return nil
}

func (f *fakeBackfillStore) RecordEnrichment(_ context.Context, log domain.RequestLog) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs = append(f.logs, log)
	return nil
}

func (f *fakeBackfillStore) statusOf(id int64) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rows[id].status
}

func (f *fakeBackfillStore) snapshotLogs() []domain.RequestLog {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]domain.RequestLog(nil), f.logs...)
}

func settingsFunc(settings domain.Settings) func(context.Context) (domain.Settings, error) {
	return func(context.Context) (domain.Settings, error) { return settings, nil }
}

func enabledSettings() domain.Settings {
	settings := domain.DefaultSettings()
	settings.ImageServiceBaseURL = "https://edge.example"
	return settings
}

func rowSource(id int64) domain.GallerySource {
	url := "https://img.example/" + string(rune('a'+id)) + ".png"
	return domain.GallerySource{
		ID: id, SourceURL: &url, MIME: "image/png", Bytes: 4, HasImage: true, Data: []byte("png"),
	}
}

func waitBackfillDone(t *testing.T, backfill *service.Backfill) service.BackfillStatus {
	t.Helper()
	var status service.BackfillStatus
	waitFor(t, func() bool {
		status = backfill.Status()
		return !status.Running
	})
	return status
}

func TestBackfillProcessesSnapshotAndProgress(t *testing.T) {
	rows := map[int64]*fakeRow{
		5: {status: "pending", source: rowSource(5)},
		4: {status: "failed", source: rowSource(4)},
		3: {status: "success", source: rowSource(3)},
		2: {status: "pending", source: rowSource(2)},
	}
	store := newFakeBackfillStore(rows)
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Succeeded: 1}}
	backfill := service.NewBackfill(service.BackfillOptions{
		Store: store, Enricher: enricher, Settings: settingsFunc(enabledSettings()),
	})
	status, err := backfill.Start(context.Background())
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if !status.Running {
		t.Fatal("start did not report running")
	}
	// A row created after the snapshot must not extend the traversal.
	store.mu.Lock()
	rows[6] = &fakeRow{status: "pending", source: rowSource(6)}
	store.mu.Unlock()

	finished := waitBackfillDone(t, backfill)
	if finished.Processed != 3 || finished.Succeeded != 3 || finished.Failed != 0 {
		t.Fatalf("status = %+v", finished)
	}
	if finished.StartedAt == nil || finished.FinishedAt == nil {
		t.Fatalf("timestamps missing: %+v", finished)
	}
	if enricher.callCount() != 3 {
		t.Fatalf("enrich calls = %d", enricher.callCount())
	}
	if store.statusOf(6) != "pending" {
		t.Fatal("post-snapshot row processed")
	}
	logs := store.snapshotLogs()
	if len(logs) != 1 || logs[0].Category != "enrich" || logs[0].Requested != 3 || logs[0].Images != 3 {
		t.Fatalf("logs = %+v", logs)
	}
}

func TestBackfillStartConflict(t *testing.T) {
	store := newFakeBackfillStore(map[int64]*fakeRow{1: {status: "pending", source: rowSource(1)}})
	block := make(chan struct{})
	started := make(chan struct{}, 1)
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Succeeded: 1}, block: block, started: started}
	backfill := service.NewBackfill(service.BackfillOptions{
		Store: store, Enricher: enricher, Settings: settingsFunc(enabledSettings()),
	})
	if _, err := backfill.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	<-started
	_, err := backfill.Start(context.Background())
	var apiErr *apierror.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 409 || apiErr.Code == nil || *apiErr.Code != "enrichment_running" {
		t.Fatalf("conflict error = %v", err)
	}
	close(block)
	waitBackfillDone(t, backfill)
}

func TestBackfillDisabledService(t *testing.T) {
	store := newFakeBackfillStore(nil)
	backfill := service.NewBackfill(service.BackfillOptions{
		Store: store, Enricher: &fakeEnricher{}, Settings: settingsFunc(domain.DefaultSettings()),
	})
	_, err := backfill.Start(context.Background())
	var apiErr *apierror.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 400 || apiErr.Code == nil || *apiErr.Code != "image_service_disabled" {
		t.Fatalf("error = %v", err)
	}
	if backfill.Status().Running {
		t.Fatal("disabled start left running state")
	}
}

func TestBackfillEmptyPassWritesNoLog(t *testing.T) {
	store := newFakeBackfillStore(map[int64]*fakeRow{})
	backfill := service.NewBackfill(service.BackfillOptions{
		Store: store, Enricher: &fakeEnricher{}, Settings: settingsFunc(enabledSettings()),
	})
	if _, err := backfill.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	finished := waitBackfillDone(t, backfill)
	if finished.Processed != 0 || len(store.snapshotLogs()) != 0 {
		t.Fatalf("empty pass: %+v logs=%+v", finished, store.snapshotLogs())
	}
}

func TestBackfillStop(t *testing.T) {
	store := newFakeBackfillStore(map[int64]*fakeRow{1: {status: "pending", source: rowSource(1)}})
	block := make(chan struct{})
	started := make(chan struct{}, 1)
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Succeeded: 1}, block: block, started: started}
	backfill := service.NewBackfill(service.BackfillOptions{
		Store: store, Enricher: enricher, Settings: settingsFunc(enabledSettings()),
	})
	if _, err := backfill.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := backfill.Stop(ctx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if backfill.Status().Running {
		t.Fatal("still running after stop")
	}
}

func TestBackfillSharedLockBlocksProcessing(t *testing.T) {
	locks := service.NewGalleryLocks()
	unlock := locks.Lock(1)
	store := newFakeBackfillStore(map[int64]*fakeRow{1: {status: "pending", source: rowSource(1)}})
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Succeeded: 1}}
	backfill := service.NewBackfill(service.BackfillOptions{
		Store: store, Enricher: enricher, Settings: settingsFunc(enabledSettings()), Locks: locks,
	})
	if _, err := backfill.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if status := backfill.Status(); status.Processed != 0 {
		t.Fatalf("processed while locked: %+v", status)
	}
	unlock()
	finished := waitBackfillDone(t, backfill)
	if finished.Processed != 1 || enricher.callCount() != 1 {
		t.Fatalf("status=%+v calls=%d", finished, enricher.callCount())
	}
}

func TestBackfillSkipsDeletedRows(t *testing.T) {
	store := newFakeBackfillStore(map[int64]*fakeRow{1: {status: "pending", source: rowSource(1), deleted: true}})
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Succeeded: 1}}
	backfill := service.NewBackfill(service.BackfillOptions{
		Store: store, Enricher: enricher, Settings: settingsFunc(enabledSettings()),
	})
	if _, err := backfill.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	finished := waitBackfillDone(t, backfill)
	if finished.Processed != 0 || enricher.callCount() != 0 || len(store.snapshotLogs()) != 0 {
		t.Fatalf("deleted row processed: %+v", finished)
	}
}

func TestBackfillFailedItemNotRetriedInPass(t *testing.T) {
	store := newFakeBackfillStore(map[int64]*fakeRow{1: {status: "pending", source: rowSource(1)}})
	enricher := &fakeEnricher{report: service.EnrichReport{Processed: 1, Succeeded: 0, Failed: 1}}
	backfill := service.NewBackfill(service.BackfillOptions{
		Store: store, Enricher: enricher, Settings: settingsFunc(enabledSettings()),
	})
	if _, err := backfill.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	finished := waitBackfillDone(t, backfill)
	if finished.Processed != 1 || finished.Failed != 1 || enricher.callCount() != 1 {
		t.Fatalf("status=%+v calls=%d", finished, enricher.callCount())
	}
	if store.pendingCalls < 1 {
		t.Fatal("pending traversal did not run")
	}
}
