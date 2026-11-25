package service_test

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

type originalReadFunc func(context.Context, int64, bool) ([]byte, string, error)

func (f originalReadFunc) GalleryContent(ctx context.Context, id int64, thumb bool) ([]byte, string, error) {
	return f(ctx, id, thumb)
}
func TestEdgeInlineBatchBudget(t *testing.T) {
	data := testutil.PNG(t, 4, 4)
	large := make([]byte, 17<<20)
	copy(large, data)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.ContentLength > 46<<20 {
			t.Error("JSON request exceeds limit")
		}
		results := map[string]any{}
		decodedSum := 0
		for _, item := range decodeBatch(t, r) {
			if item.Base64 != "" {
				original, err := base64.StdEncoding.DecodeString(item.Base64)
				if err != nil {
					t.Error(err)
				}
				decodedSum += len(original)
			}
			results[item.UUID] = map[string]any{"status": "ok", "data": map[string]any{"nsfw": map[string]any{"safe": 1, "drawing": 0, "hentai": 0, "porn": 0, "sexy": 0, "isNsfw": false}}}
		}
		if decodedSum > 32<<20 {
			t.Errorf("actual decoded budget exceeded: %d", decodedSum)
		}
		writeJSON(w, results)
	}))
	defer server.Close()
	// Stale metadata underestimates bodies: actual loaded bytes must still split.
	edge := service.NewEdge(server.Client()).WithOriginalReader(originalReadFunc(func(context.Context, int64, bool) ([]byte, string, error) { return large, "image/png", nil }))
	settings := edgeSettings(server.URL)
	// This tests byte budgets, not a two-second wall-clock deadline under race instrumentation.
	settings.EnrichTimeoutMS = 30000
	report, err := edge.Enrich(context.Background(), []domain.GallerySource{{ID: 1, Bytes: 1, MIME: "image/png"}, {ID: 2, Bytes: 1, MIME: "image/png"}}, settings)
	if err != nil || report.Succeeded != 2 || requests != 2 {
		t.Fatalf("budget: %+v %v requests=%d", report, err, requests)
	}
}

func TestEdgeURLPriorityDoesNotReadOriginal(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		results := map[string]any{}
		for _, item := range decodeBatch(t, r) {
			if item.URL == "" {
				t.Error("URL not preferred")
			}
			results[item.UUID] = map[string]any{"status": "ok", "data": map[string]any{"nsfw": map[string]any{"safe": 1, "drawing": 0, "hentai": 0, "porn": 0, "sexy": 0, "isNsfw": false}}}
		}
		writeJSON(w, results)
	}))
	defer server.Close()
	edge := service.NewEdge(server.Client()).WithOriginalReader(originalReadFunc(func(context.Context, int64, bool) ([]byte, string, error) { calls++; return nil, "", nil }))
	sourceURL := "https://source.example/image.png"
	report, err := edge.Enrich(context.Background(), []domain.GallerySource{{ID: 1, SourceURL: &sourceURL, MIME: "image/png", Bytes: 68}}, edgeSettings(server.URL))
	if err != nil || report.Succeeded != 1 || calls != 0 {
		t.Fatalf("%+v %v reads=%d", report, err, calls)
	}
}
func TestEdgeURLFailureLoadsOriginalOnce(t *testing.T) {
	data := testutil.PNG(t, 4, 4)
	reads, requests := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		results := map[string]any{}
		for _, item := range decodeBatch(t, r) {
			if item.URL != "" {
				results[item.UUID] = map[string]any{"status": "error", "error": "fetch failed"}
				continue
			}
			decoded, err := base64.StdEncoding.DecodeString(item.Base64)
			if err != nil || string(decoded) != string(data) || item.ContentType != "image/png" {
				t.Error("original fallback mismatch")
			}
			results[item.UUID] = map[string]any{"status": "ok", "data": map[string]any{"nsfw": map[string]any{"safe": 1, "drawing": 0, "hentai": 0, "porn": 0, "sexy": 0, "isNsfw": false}}}
		}
		writeJSON(w, results)
	}))
	defer server.Close()
	edge := service.NewEdge(server.Client()).WithOriginalReader(originalReadFunc(func(context.Context, int64, bool) ([]byte, string, error) { reads++; return data, "image/png", nil }))
	sourceURL := "https://source.example/image.png"
	report, err := edge.Enrich(context.Background(), []domain.GallerySource{{ID: 1, SourceURL: &sourceURL, MIME: "image/png", Bytes: int64(len(data))}}, edgeSettings(server.URL))
	if err != nil || report.Succeeded != 1 || reads != 1 || requests != 2 {
		t.Fatalf("%+v %v reads=%d requests=%d", report, err, reads, requests)
	}
}
func TestEnrichmentJobOnlyUsesExistingIDs(t *testing.T) {
	s, constructErr := store.New(testutil.OpenDB(t), nil, t.TempDir())
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	ids := []int64{}
	for i := 0; i < 3; i++ {
		image, err := s.SaveGeneratedImage(ctx, domain.GalleryInsert{OutputKey: "job:" + strconv.Itoa(i), Image: testutil.PNG(t, 4, 4), ImageMIME: strPtr("image/png")})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, image.ID)
	}
	_ = s.SetEnrichment(ctx, ids[1], domain.EnrichmentWrite{Status: "success"})
	_, _ = s.DeleteGallery(ctx, ids[2])
	processed := []int64{}
	runner := service.NewEnrichmentJobs(service.EnrichmentJobOptions{Store: s, Enricher: enricherFunc(func(ctx context.Context, sources []domain.GallerySource, _ domain.Settings) (service.EnrichReport, error) {
		for _, source := range sources {
			processed = append(processed, source.ID)
			_, _ = s.DeleteGallery(ctx, source.ID)
			_ = s.SetEnrichment(ctx, source.ID, domain.EnrichmentWrite{Status: "success"})
		}
		return service.EnrichReport{Processed: 1, Succeeded: 1}, nil
	})})
	settings := domain.DefaultSettings()
	settings.ImageServiceBaseURL = "https://edge.example"
	if err := runner.Run(ctx, service.EnrichmentJob{RequestID: "job", IDs: ids, Settings: settings}); err != nil {
		t.Fatal(err)
	}
	if len(processed) != 1 || processed[0] != ids[0] {
		t.Fatalf("processed wrong rows: %v", processed)
	}
	page, err := s.ListGallery(ctx, domain.CursorQuery{})
	if err != nil || len(page.Items) != 1 {
		t.Fatal("deleted original resurrected", page, err)
	}
	overview, _ := s.Overview(ctx, "2026-11-24", "2026-11-24")
	if overview.Totals.Requests != 0 {
		t.Fatal("enrichment charged usage")
	}
}

type enricherFunc func(context.Context, []domain.GallerySource, domain.Settings) (service.EnrichReport, error)

func (f enricherFunc) Enrich(ctx context.Context, sources []domain.GallerySource, settings domain.Settings) (service.EnrichReport, error) {
	return f(ctx, sources, settings)
}
