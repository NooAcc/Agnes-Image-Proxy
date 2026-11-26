package store_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
)

func ptr[T any](v T) *T { return &v }

func requestLog(ts time.Time, category, stage, model string, requested, images, failed int) domain.RequestLog {
	return domain.RequestLog{
		RequestID:  "req-1",
		TS:         ts,
		Category:   category,
		Stage:      stage,
		Endpoint:   "generations",
		Path:       "/v1/images/generations",
		Model:      model,
		Status:     200,
		OK:         true,
		Requested:  requested,
		Images:     images,
		Failed:     failed,
		DurationMS: 12,
		Attempts: []domain.Attempt{{
			Index: 0, AccountID: 1, AccountName: "a", Status: 200, Code: "", DurationMS: 10, Message: "",
		}},
	}
}

func TestRecordRequestUsagePartial(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	ts := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	if err := s.RecordRequest(ctx, requestLog(ts, "request", "complete", "model-a", 5, 3, 2)); err != nil {
		t.Fatalf("record: %v", err)
	}
	overview, err := s.Overview(ctx, "2026-11-24", "2026-11-24")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	want := domain.UsageTotals{Requests: 1, Successes: 1, Partials: 1, Failures: 0, Images: 3}
	if overview.Totals != want {
		t.Fatalf("totals = %+v, want %+v", overview.Totals, want)
	}
	if len(overview.Models) != 1 || overview.Models[0].Model != "model-a" || overview.Models[0].UsageTotals != want {
		t.Fatalf("models = %+v", overview.Models)
	}
	if len(overview.Days) != 1 || overview.Days[0].Day != "2026-11-24" || overview.Days[0].UsageTotals != want {
		t.Fatalf("days = %+v", overview.Days)
	}
}

func TestRecordRequestFullFailure(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	log := requestLog(time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC), "request", "complete", "model-a", 2, 0, 2)
	log.OK = true // contradictory caller value must not be trusted
	log.Failed = 0
	if err := s.RecordRequest(ctx, log); err != nil {
		t.Fatalf("record: %v", err)
	}
	overview, _ := s.Overview(ctx, "2026-11-24", "2026-11-24")
	want := domain.UsageTotals{Requests: 1, Successes: 0, Partials: 0, Failures: 1, Images: 0}
	if overview.Totals != want {
		t.Fatalf("totals = %+v", overview.Totals)
	}
	logs, err := s.ListLogs(ctx, domain.CursorQuery{Category: "request"})
	if err != nil || len(logs.Items) != 1 {
		t.Fatalf("logs: %v %d", err, len(logs.Items))
	}
	if logs.Items[0].OK {
		t.Fatal("log ok flag trusted caller instead of actual images")
	}
	if logs.Items[0].Failed != 2 {
		t.Fatalf("derived failed = %d", logs.Items[0].Failed)
	}
}

func TestRecordRequestParseWithoutModelHasNoUsage(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	if err := s.RecordRequest(ctx, requestLog(time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC), "request", "parse", "", 0, 0, 0)); err != nil {
		t.Fatalf("record: %v", err)
	}
	overview, _ := s.Overview(ctx, "2026-11-24", "2026-11-24")
	if overview.Totals.Requests != 0 {
		t.Fatalf("parse log created usage: %+v", overview.Totals)
	}
	logs, _ := s.ListLogs(ctx, domain.CursorQuery{})
	if len(logs.Items) != 1 {
		t.Fatalf("parse log missing: %d", len(logs.Items))
	}
}

func TestRecordRequestAtomicOnUsageFailure(t *testing.T) {
	s, db := newInitializedSchemaStore(t)
	ctx := context.Background()
	if _, err := db.Exec("DROP TABLE model_usage_daily"); err != nil {
		t.Fatalf("drop: %v", err)
	}
	err := s.RecordRequest(ctx, requestLog(time.Now().UTC(), "request", "complete", "model-a", 1, 1, 0))
	if err == nil {
		t.Fatal("expected usage failure")
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Fatalf("log persisted despite usage failure: %d", count)
	}
}

func TestRecordEnrichmentOnlyLog(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	log := requestLog(time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC), "enrich", "complete", "", 0, 0, 0)
	log.Requested = 1
	log.Images = 1
	if err := s.RecordEnrichment(ctx, log); err != nil {
		t.Fatalf("record: %v", err)
	}
	overview, _ := s.Overview(ctx, "2026-11-24", "2026-11-24")
	if overview.Totals.Requests != 0 {
		t.Fatalf("enrich log created usage: %+v", overview.Totals)
	}
	logs, _ := s.ListLogs(ctx, domain.CursorQuery{Category: "enrich"})
	if len(logs.Items) != 1 || logs.Items[0].Category != "enrich" {
		t.Fatalf("logs = %+v", logs.Items)
	}
}

func TestListLogsCursorAndFilter(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		category := "request"
		if i%2 == 1 {
			category = "enrich"
		}
		log := requestLog(base.Add(time.Duration(i)*time.Minute), category, "complete", "m", 1, 1, 0)
		log.RequestID = "req-" + string(rune('a'+i))
		if err := s.RecordRequest(ctx, log); err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
	}

	first, err := s.ListLogs(ctx, domain.CursorQuery{Category: "request", Limit: 2})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(first.Items) != 2 || first.NextBefore == nil {
		t.Fatalf("first page = %+v", first)
	}
	second, err := s.ListLogs(ctx, domain.CursorQuery{Category: "request", Limit: 2, Before: first.NextBefore})
	if err != nil {
		t.Fatalf("list 2: %v", err)
	}
	seen := map[int64]bool{}
	for _, item := range append(first.Items, second.Items...) {
		if seen[item.ID] {
			t.Fatalf("duplicate log id %d", item.ID)
		}
		seen[item.ID] = true
		if item.Category != "request" {
			t.Fatalf("category leaked: %s", item.Category)
		}
		if len(item.Attempts) != 1 || item.Attempts[0].AccountName != "a" {
			t.Fatalf("attempts not persisted: %+v", item.Attempts)
		}
	}
	if second.NextBefore != nil {
		t.Fatalf("unexpected next page: %v", *second.NextBefore)
	}

	if _, err := s.ListLogs(ctx, domain.CursorQuery{Category: "bogus"}); err == nil {
		t.Fatal("unknown category accepted")
	} else {
		var apiErr *apierror.Error
		if !errors.As(err, &apiErr) || apiErr.Status != 400 {
			t.Fatalf("category error = %v", err)
		}
	}
}

func TestClearLogsKeepsUsage(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	if err := s.RecordRequest(ctx, requestLog(time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC), "request", "complete", "m", 1, 1, 0)); err != nil {
		t.Fatalf("record: %v", err)
	}
	if err := s.ClearLogs(ctx); err != nil {
		t.Fatalf("clear: %v", err)
	}
	logs, _ := s.ListLogs(ctx, domain.CursorQuery{})
	if len(logs.Items) != 0 {
		t.Fatalf("logs remain: %d", len(logs.Items))
	}
	overview, _ := s.Overview(ctx, "2026-11-24", "2026-11-24")
	if overview.Totals.Requests != 1 {
		t.Fatalf("usage cleared with logs: %+v", overview.Totals)
	}
}

func TestOverviewZeroFillAndValidation(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	day1 := time.Date(2026, 11, 20, 15, 59, 59, 999999999, time.UTC)
	day2 := time.Date(2026, 11, 21, 16, 0, 0, 0, time.UTC)
	_ = s.RecordRequest(ctx, requestLog(day1, "request", "complete", "model-a", 2, 2, 0))
	_ = s.RecordRequest(ctx, requestLog(day2, "request", "complete", "model-b", 1, 0, 1))

	overview, err := s.Overview(ctx, "2026-11-20", "2026-11-23")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if len(overview.Days) != 4 {
		t.Fatalf("days = %d", len(overview.Days))
	}
	expected := map[string]domain.UsageTotals{
		"2026-11-20": {Requests: 1, Successes: 1, Images: 2},
		"2026-11-21": {},
		"2026-11-22": {Requests: 1, Failures: 1},
		"2026-11-23": {},
	}
	for _, day := range overview.Days {
		if day.UsageTotals != expected[day.Day] {
			t.Fatalf("day %s = %+v", day.Day, day.UsageTotals)
		}
	}
	if overview.Totals.Requests != 2 || overview.Totals.Successes != 1 || overview.Totals.Failures != 1 || overview.Totals.Images != 2 {
		t.Fatalf("totals = %+v", overview.Totals)
	}
	var modelTotal domain.UsageTotals
	for _, model := range overview.Models {
		modelTotal.Requests += model.Requests
		modelTotal.Successes += model.Successes
		modelTotal.Failures += model.Failures
		modelTotal.Images += model.Images
	}
	if modelTotal != overview.Totals {
		t.Fatalf("model total %+v != totals %+v", modelTotal, overview.Totals)
	}

	for _, tc := range []struct{ start, end string }{
		{"2026-11-24", "2026-11-20"},
		{"2026-11-20", "2026-11-20x"},
		{"2026-01-01", "2027-06-01"},
	} {
		if _, err := s.Overview(ctx, tc.start, tc.end); err == nil {
			t.Fatalf("range %v accepted", tc)
		}
	}
}

func TestOverviewAccountHealth(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	seedAccounts(t, s, 3)
	disabled := false
	if _, err := s.UpdateAccount(ctx, 2, domain.AccountPatch{Enabled: &disabled}); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if err := s.RecordFailure(ctx, 3, 10*time.Minute); err != nil {
		t.Fatalf("failure: %v", err)
	}
	overview, err := s.Overview(ctx, "2026-11-24", "2026-11-24")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if overview.Accounts.Total != 3 || overview.Accounts.Healthy != 1 || overview.Accounts.Cooling != 1 || overview.Accounts.Disabled != 1 {
		t.Fatalf("account health = %+v", overview.Accounts)
	}
}

func TestGalleryInsertListContent(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	blob := []byte{0x00, 0xff, 0x10, 0x00, 0x7f}
	id, err := s.InsertGallery(ctx, domain.GalleryInsert{
		RequestID:   "req-1",
		OutputKey:   "req-1:0:0",
		Model:       "m",
		Prompt:      "p",
		SizeRequest: "1K",
		AccountName: "account",
		SourceURL:   ptr("https://img.example/a.png"),
		Image:       blob,
		ImageMIME:   ptr("image/png"),
	})
	if err != nil || id == 0 {
		t.Fatalf("insert: %d %v", id, err)
	}

	content, mime, err := s.GalleryContent(ctx, id, false)
	if err != nil || mime != "image/png" || !bytes.Equal(content, blob) {
		t.Fatalf("content: %q %v", mime, err)
	}
	if _, _, err := s.GalleryContent(ctx, id, true); err == nil {
		t.Fatal("missing thumbnail returned content")
	} else {
		var apiErr *apierror.Error
		if !errors.As(err, &apiErr) || apiErr.Status != 404 {
			t.Fatalf("thumbnail error = %v", err)
		}
	}

	page, err := s.ListGallery(ctx, domain.CursorQuery{})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list: %v %d", err, len(page.Items))
	}
	item := page.Items[0]
	if item.Size != "1K" || item.Archived != true || item.EnrichStatus != "pending" || item.Tag != "" {
		t.Fatalf("item = %+v", item)
	}
	if item.SourceURL == nil || *item.SourceURL != "https://img.example/a.png" {
		t.Fatalf("source url = %v", item.SourceURL)
	}
}

func TestGalleryRejectsUnknownMimeBytes(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	id, err := s.InsertGallery(ctx, domain.GalleryInsert{
		SourceURL: ptr("https://img.example/a.gif"),
		OutputKey: "unknown:0:0",
		Image:     []byte("GIF89a"),
		ImageMIME: ptr("image/gif"),
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	if _, _, err := s.GalleryContent(ctx, id, false); err == nil {
		t.Fatal("unknown mime bytes stored")
	}
	page, _ := s.ListGallery(ctx, domain.CursorQuery{})
	if len(page.Items) != 1 || page.Items[0].Archived {
		t.Fatalf("item = %+v", page.Items)
	}
}

func TestGalleryCursorTagAndDelete(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	tags := []string{"safe", "porn", "safe", "hentai", "safe"}
	var ids []int64
	for i, tag := range tags {
		id, err := s.InsertGallery(ctx, domain.GalleryInsert{
			RequestID: "req",
			OutputKey: fmt.Sprintf("req:%d:0", i),
			Model:     "m",
			Prompt:    "p",
			Image:     []byte{0x89, 'P', 'N', 'G'},
			ImageMIME: ptr("image/png"),
		})
		if err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
		ids = append(ids, id)
		if err := s.SetEnrichment(ctx, id, domain.EnrichmentWrite{
			Status: "success",
			Tag:    tag,
			At:     time.Now().UTC(),
		}); err != nil {
			t.Fatalf("enrich %d: %v", i, err)
		}
	}

	first, err := s.ListGallery(ctx, domain.CursorQuery{Tag: "safe", Limit: 2})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(first.Items) != 2 || first.NextBefore == nil {
		t.Fatalf("first page = %+v", first)
	}
	second, err := s.ListGallery(ctx, domain.CursorQuery{Tag: "safe", Limit: 2, Before: first.NextBefore})
	if err != nil {
		t.Fatalf("list 2: %v", err)
	}
	if len(second.Items) != 1 {
		t.Fatalf("second page = %+v", second.Items)
	}
	seen := map[int64]bool{}
	for _, item := range append(first.Items, second.Items...) {
		if seen[item.ID] {
			t.Fatalf("duplicate %d", item.ID)
		}
		seen[item.ID] = true
		if item.Tag != "safe" {
			t.Fatalf("tag leak: %s", item.Tag)
		}
	}
	if _, err := s.ListGallery(ctx, domain.CursorQuery{Tag: "bogus"}); err == nil {
		t.Fatal("unknown tag accepted")
	}

	if ok, err := s.DeleteGallery(ctx, ids[1]); err != nil || !ok {
		t.Fatalf("delete: %v %v", ok, err)
	}
	if _, _, err := s.GalleryContent(ctx, ids[1], false); err == nil {
		t.Fatal("deleted content still available")
	}
	if err := s.SetEnrichment(ctx, ids[1], domain.EnrichmentWrite{Status: "success", Tag: "safe"}); err != nil {
		t.Fatalf("async enrich after delete should be a no-op: %v", err)
	}
	if page, _ := s.ListGallery(ctx, domain.CursorQuery{Tag: "safe"}); len(page.Items) != 3 {
		t.Fatalf("deleted row resurrected: %+v", page.Items)
	}

	if err := s.ClearGallery(ctx); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if page, _ := s.ListGallery(ctx, domain.CursorQuery{}); len(page.Items) != 0 {
		t.Fatalf("gallery not cleared: %d", len(page.Items))
	}
}

func TestGallerySizeUsesActual(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	actual := "864x1152"
	if _, err := s.InsertGallery(ctx, domain.GalleryInsert{
		OutputKey:   "size:0:0",
		SizeRequest: "1K", SizeActual: &actual, Image: []byte{0x89, 'P', 'N', 'G'}, ImageMIME: ptr("image/png"),
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	page, _ := s.ListGallery(ctx, domain.CursorQuery{})
	if page.Items[0].Size != actual {
		t.Fatalf("size = %q", page.Items[0].Size)
	}
}

func TestGallerySourcesAndPendingEnrichment(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	mime := "image/png"
	var ids []int64
	for i := 0; i < 4; i++ {
		id, err := s.InsertGallery(ctx, domain.GalleryInsert{
			OutputKey:   fmt.Sprintf("sources:%d:0", i),
			SourceURL:   ptr("https://img.example/" + string(rune('a'+i)) + ".png"),
			SourceMIME:  &mime,
			SourceBytes: ptr(int64(100 + i)),
			Image:       []byte{0x89, 'P', 'N', 'G', byte(i)},
			ImageMIME:   &mime,
		})
		if err != nil {
			t.Fatalf("insert: %v", err)
		}
		ids = append(ids, id)
	}
	if err := s.SetEnrichment(ctx, ids[3], domain.EnrichmentWrite{Status: "success", Tag: "safe"}); err != nil {
		t.Fatalf("enrich: %v", err)
	}

	sources, err := s.GallerySources(ctx, []int64{ids[0], ids[2]})
	if err != nil || len(sources) != 2 {
		t.Fatalf("sources: %v %d", err, len(sources))
	}
	if sources[0].ID != ids[0] || sources[1].ID != ids[2] {
		t.Fatalf("source order = %+v", sources)
	}
	if sources[0].Bytes != 5 || sources[0].SourceBytes != 100 || sources[0].Bytes <= 0 {
		t.Fatalf("source = %+v", sources[0])
	}

	pending, err := s.PendingEnrichment(ctx, nil, 2)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(pending) != 2 || pending[0].ID != ids[2] || pending[1].ID != ids[1] {
		t.Fatalf("pending = %+v", pending)
	}
	cursor := pending[1].ID
	next, err := s.PendingEnrichment(ctx, &cursor, 2)
	if err != nil || len(next) != 1 || next[0].ID != ids[0] {
		t.Fatalf("next pending: %v %+v", err, next)
	}
}

func TestGalleryEnrichState(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	mime := "image/png"
	id, err := s.InsertGallery(ctx, domain.GalleryInsert{
		OutputKey:   "enrich:0:0",
		SourceURL:   ptr("https://img.example/a.png"),
		SourceMIME:  &mime,
		SourceBytes: ptr(int64(100)),
		Image:       []byte{0x89, 'P', 'N', 'G'},
		ImageMIME:   &mime,
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}

	status, source, found, err := s.GalleryEnrichState(ctx, id)
	if err != nil || !found {
		t.Fatalf("state: %v found=%v", err, found)
	}
	if status != "pending" || source.ID != id || source.SourceURL == nil || *source.SourceURL != "https://img.example/a.png" {
		t.Fatalf("status=%q source=%+v", status, source)
	}
	if source.Bytes != 4 || source.SourceBytes != 100 || source.Bytes <= 0 {
		t.Fatalf("source = %+v", source)
	}

	if err := s.SetEnrichment(ctx, id, domain.EnrichmentWrite{Status: "success", Tag: "safe"}); err != nil {
		t.Fatalf("enrich: %v", err)
	}
	status, _, _, err = s.GalleryEnrichState(ctx, id)
	if err != nil || status != "success" {
		t.Fatalf("after enrich: %v status=%q", err, status)
	}

	status, _, found, err = s.GalleryEnrichState(ctx, id+1000)
	if err != nil || found || status != "" {
		t.Fatalf("missing row: err=%v found=%v status=%q", err, found, status)
	}
}

func TestSetEnrichmentThumbAndScores(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	id, err := s.InsertGallery(ctx, domain.GalleryInsert{
		OutputKey: "thumbnail:0:0",
		Image:     []byte{0x89, 'P', 'N', 'G'}, ImageMIME: ptr("image/png"),
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	thumb := []byte{0x52, 0x49, 0x46, 0x46}
	if err := s.SetEnrichment(ctx, id, domain.EnrichmentWrite{
		Thumb:     thumb,
		ThumbMIME: "image/webp",
		Status:    "success",
		Tag:       "sexy",
		Scores:    &domain.NSFWScores{Drawing: 0.1, Hentai: 0.2, Safe: 0.3, Porn: 0.1, Sexy: 0.3, IsNSFW: true},
		At:        time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("enrich: %v", err)
	}
	content, mime, err := s.GalleryContent(ctx, id, true)
	if err != nil || mime != "image/webp" || !bytes.Equal(content, thumb) {
		t.Fatalf("thumb: %q %v", mime, err)
	}
	page, _ := s.ListGallery(ctx, domain.CursorQuery{})
	if page.Items[0].Tag != "sexy" || page.Items[0].EnrichStatus != "success" {
		t.Fatalf("item = %+v", page.Items[0])
	}
	if page.Items[0].NSFWScores == nil || page.Items[0].NSFWScores.Sexy != 0.3 {
		t.Fatalf("scores = %+v", page.Items[0].NSFWScores)
	}
}

func TestGalleryCursorInvalidLimit(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	if _, err := s.ListGallery(ctx, domain.CursorQuery{Before: ptr(int64(-1))}); err == nil {
		t.Fatal("negative cursor accepted")
	}
	page, err := s.ListGallery(ctx, domain.CursorQuery{Limit: 1000})
	if err != nil || page.Items == nil {
		t.Fatalf("limit clamp: %v", err)
	}
}

func TestRecordRequestConcurrentUsage(t *testing.T) {
	s, _ := newInitializedSchemaStore(t)
	ctx := context.Background()
	ts := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			log := requestLog(ts, "request", "complete", "model-a", 1, 1, 0)
			log.RequestID = fmt.Sprintf("req-%d", index)
			errs <- s.RecordRequest(ctx, log)
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent record: %v", err)
		}
	}
	overview, err := s.Overview(ctx, "2026-11-24", "2026-11-24")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if overview.Totals.Requests != 20 || overview.Totals.Successes != 20 || overview.Totals.Images != 20 {
		t.Fatalf("totals = %+v", overview.Totals)
	}
}

var _ = store.DefaultTimeout
