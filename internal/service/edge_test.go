package service_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func edgeSettings(baseURL string) domain.Settings {
	settings := domain.DefaultSettings()
	settings.ImageServiceBaseURL = baseURL
	settings.ThumbnailWidth = 640
	settings.ThumbnailQuality = 75
	settings.EnrichTimeoutMS = 2000
	return settings
}

func strPtr(v string) *string { return &v }

type batchItem struct {
	UUID        string         `json:"uuid"`
	URL         string         `json:"url"`
	Base64      string         `json:"base64"`
	ContentType string         `json:"contentType"`
	Params      map[string]any `json:"params"`
}

func decodeBatch(t *testing.T, r *http.Request) []batchItem {
	t.Helper()
	var items []batchItem
	if err := json.NewDecoder(r.Body).Decode(&items); err != nil {
		t.Errorf("decode batch: %v", err)
		return nil
	}
	return items
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func TestMeasureEmptyServiceMakesNoRequest(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer server.Close()

	edge := service.NewEdge(server.Client())
	outputs := []domain.OutputImage{{URL: strPtr("https://img.example/a.png")}}
	measurements, warnings := edge.Measure(context.Background(), outputs, edgeSettings(""))
	if len(measurements) != 1 || measurements[0].Size != nil || measurements[0].Format != nil {
		t.Fatalf("measurements = %+v", measurements)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v", warnings)
	}
	if called {
		t.Fatal("image service was called while disabled")
	}
}

func TestMeasureBatchesAndFailures(t *testing.T) {
	var mu sync.Mutex
	var batches [][]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		items := decodeBatch(t, r)
		mu.Lock()
		var uuids []string
		for _, item := range items {
			uuids = append(uuids, item.UUID)
			if item.Params["format"] != "json" {
				t.Errorf("params = %v", item.Params)
			}
		}
		batches = append(batches, uuids)
		mu.Unlock()

		out := map[string]any{}
		for _, item := range items {
			switch item.UUID {
			case "1":
				out[item.UUID] = map[string]any{"success": false, "error": "bad image"}
			case "2":
				out[item.UUID] = map[string]any{"success": true, "data": map[string]any{"width": 864, "height": 1152}}
			default:
				out[item.UUID] = map[string]any{"status": "ok", "data": map[string]any{"width": 100, "height": 200, "format": "jpg"}}
			}
		}
		writeJSON(w, out)
	}))
	defer server.Close()

	outputs := make([]domain.OutputImage, 21)
	for i := range outputs {
		outputs[i] = domain.OutputImage{URL: strPtr(fmt.Sprintf("https://img.example/%d.png", i))}
	}
	edge := service.NewEdge(server.Client())
	measurements, warnings := edge.Measure(context.Background(), outputs, edgeSettings(server.URL))
	if len(measurements) != 21 {
		t.Fatalf("measurements = %d", len(measurements))
	}
	if len(batches) != 2 || len(batches[0]) != 20 || len(batches[1]) != 1 {
		t.Fatalf("batches = %v", batches)
	}
	seen := map[string]bool{}
	for _, batch := range batches {
		for _, uuid := range batch {
			if seen[uuid] {
				t.Fatalf("duplicate uuid %s", uuid)
			}
			seen[uuid] = true
		}
	}
	if measurements[1].Size != nil || measurements[1].Format != nil {
		t.Fatalf("failed item measured: %+v", measurements[1])
	}
	if measurements[2].Size == nil || measurements[2].Size.Width != 864 || measurements[2].Size.Height != 1152 {
		t.Fatalf("item 2 = %+v", measurements[2])
	}
	if measurements[2].Format != nil {
		t.Fatalf("missing format should stay nil: %+v", measurements[2])
	}
	if measurements[0].Format == nil || *measurements[0].Format != "jpeg" {
		t.Fatalf("format = %v", measurements[0].Format)
	}
	if len(warnings) != 1 || warnings[0] != "size-measure-failed" {
		t.Fatalf("warnings = %v", warnings)
	}
}

func TestMeasureSourceContentTypeFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		items := decodeBatch(t, r)
		out := map[string]any{}
		for _, item := range items {
			out[item.UUID] = map[string]any{"success": true, "data": map[string]any{
				"width": 10, "height": 20, "sourceContentType": "image/jpeg",
			}}
		}
		writeJSON(w, out)
	}))
	defer server.Close()

	edge := service.NewEdge(server.Client())
	measurements, warnings := edge.Measure(context.Background(),
		[]domain.OutputImage{{URL: strPtr("https://img.example/a.png")}}, edgeSettings(server.URL))
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v", warnings)
	}
	if measurements[0].Format == nil || *measurements[0].Format != "jpeg" {
		t.Fatalf("format = %v", measurements[0].Format)
	}
}

func TestMeasureTimeoutContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	edge := service.NewEdge(server.Client())
	measurements, warnings := edge.Measure(ctx,
		[]domain.OutputImage{{URL: strPtr("https://img.example/a.png")}}, edgeSettings(server.URL))
	if measurements[0].Size != nil || len(warnings) != 1 || warnings[0] != "size-measure-failed" {
		t.Fatalf("measurements=%+v warnings=%v", measurements, warnings)
	}
}

func TestTagForNSFW(t *testing.T) {
	cases := []struct {
		name   string
		scores domain.NSFWScores
		want   string
	}{
		{"safe", domain.NSFWScores{Safe: 0.9, Drawing: 0.1}, "safe"},
		{"drawing", domain.NSFWScores{Safe: 0.1, Drawing: 0.9}, "drawing"},
		{"sexy", domain.NSFWScores{Safe: 0.1, Sexy: 0.9}, "sexy"},
		{"porn", domain.NSFWScores{Safe: 0.1, Porn: 0.9}, "porn"},
		{"hentai", domain.NSFWScores{Safe: 0.1, Hentai: 0.9}, "hentai"},
		{"tie safe/porn", domain.NSFWScores{Safe: 0.5, Porn: 0.5}, "safe"},
		{"tie drawing/sexy", domain.NSFWScores{Drawing: 0.5, Sexy: 0.5}, "drawing"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := service.TagForNSFW(tc.scores)
			if err != nil || got != tc.want {
				t.Fatalf("tag = %q err=%v", got, err)
			}
		})
	}
	if _, err := service.TagForNSFW(domain.NSFWScores{Safe: math.NaN()}); err == nil {
		t.Fatal("NaN accepted")
	}
	if _, err := service.TagForNSFW(domain.NSFWScores{Safe: 1.5}); err == nil {
		t.Fatal("out-of-range score accepted")
	}
}

type fakeWriter struct {
	mu     sync.Mutex
	writes map[int64]domain.EnrichmentWrite
	err    error
}

func newFakeWriter() *fakeWriter {
	return &fakeWriter{writes: make(map[int64]domain.EnrichmentWrite)}
}

func (f *fakeWriter) SetEnrichment(_ context.Context, id int64, write domain.EnrichmentWrite) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.writes[id] = write
	return nil
}

func (f *fakeWriter) get(id int64) (domain.EnrichmentWrite, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	write, ok := f.writes[id]
	return write, ok
}

func gallerySource(id int64, url *string, data []byte) domain.GallerySource {
	source := domain.GallerySource{ID: id, SourceURL: url}
	if data != nil {
		source.Data = data
		source.Bytes = int64(len(data))
		source.MIME = "image/png"
		source.HasImage = true
	}
	return source
}

func nsfwJSON(safe, porn float64) map[string]any {
	return map[string]any{"drawing": 0.01, "hentai": 0.01, "safe": safe, "porn": porn, "sexy": 0.01, "isNsfw": true}
}

func TestEnrichWritesSuccessAndFailures(t *testing.T) {
	thumb := testutil.PNG(t, 2, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		items := decodeBatch(t, r)
		out := map[string]any{}
		for _, item := range items {
			switch item.UUID {
			case "1":
				out[item.UUID] = map[string]any{"success": true, "data": map[string]any{
					"nsfw": nsfwJSON(0.9, 0.05), "base64": base64.StdEncoding.EncodeToString(thumb), "contentType": "image/png",
				}}
			case "2":
				out[item.UUID] = map[string]any{"success": true, "data": map[string]any{"base64": ""}}
			}
		}
		writeJSON(w, out)
	}))
	defer server.Close()

	writer := newFakeWriter()
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(writer)
	sources := []domain.GallerySource{
		gallerySource(1, strPtr("https://img.example/a.png"), nil),
		gallerySource(2, strPtr("https://img.example/b.png"), nil),
	}
	report, err := edge.Enrich(context.Background(), sources, edgeSettings(server.URL))
	if err != nil {
		t.Fatalf("enrich: %v", err)
	}
	if report.Processed != 2 || report.Succeeded != 1 || report.Failed != 1 {
		t.Fatalf("report = %+v", report)
	}
	success, ok := writer.get(1)
	if !ok || success.Status != "success" || success.Tag != "safe" || success.ThumbMIME != "image/png" || len(success.Thumb) == 0 {
		t.Fatalf("success write = %+v", success)
	}
	failure, ok := writer.get(2)
	if !ok || failure.Status != "failed" || failure.Error == nil || !strings.Contains(*failure.Error, "prediction unavailable") {
		t.Fatalf("failure write = %+v", failure)
	}
}

func TestEnrichParamsAndURLPriority(t *testing.T) {
	var captured []batchItem
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = decodeBatch(t, r)
		out := map[string]any{}
		for _, item := range captured {
			out[item.UUID] = map[string]any{"success": true, "data": map[string]any{"nsfw": nsfwJSON(0.9, 0.05)}}
		}
		writeJSON(w, out)
	}))
	defer server.Close()

	writer := newFakeWriter()
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(writer)
	sources := []domain.GallerySource{
		gallerySource(1, strPtr("https://img.example/a.png"), []byte("orig")),
		gallerySource(2, nil, []byte("inline")),
	}
	if _, err := edge.Enrich(context.Background(), sources, edgeSettings(server.URL)); err != nil {
		t.Fatalf("enrich: %v", err)
	}
	if len(captured) != 2 {
		t.Fatalf("items = %d", len(captured))
	}
	byID := map[string]batchItem{}
	for _, item := range captured {
		byID[item.UUID] = item
	}
	if byID["1"].URL != "https://img.example/a.png" || byID["1"].Base64 != "" {
		t.Fatalf("url item = %+v", byID["1"])
	}
	if byID["2"].URL != "" || byID["2"].Base64 == "" || byID["2"].ContentType != "image/png" {
		t.Fatalf("base64 item = %+v", byID["2"])
	}
	params := byID["1"].Params
	if params["width"] != float64(640) || params["height"] != float64(640) || params["crop"] != "none" ||
		params["size"] != "down" || params["format"] != "webp" || params["quality"] != float64(75) || params["nsfw"] != float64(1) {
		t.Fatalf("params = %v", params)
	}
}

func TestEnrichURLFallbackOnce(t *testing.T) {
	var mu sync.Mutex
	var requests [][]batchItem
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		items := decodeBatch(t, r)
		mu.Lock()
		requests = append(requests, items)
		mu.Unlock()
		out := map[string]any{}
		for _, item := range items {
			if item.URL != "" {
				out[item.UUID] = map[string]any{"success": false, "error": "fetch failed"}
			} else {
				out[item.UUID] = map[string]any{"success": true, "data": map[string]any{"nsfw": nsfwJSON(0.2, 0.8)}}
			}
		}
		writeJSON(w, out)
	}))
	defer server.Close()

	writer := newFakeWriter()
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(writer)
	sources := []domain.GallerySource{gallerySource(1, strPtr("https://img.example/a.png"), []byte("local-copy"))}
	report, err := edge.Enrich(context.Background(), sources, edgeSettings(server.URL))
	if err != nil {
		t.Fatalf("enrich: %v", err)
	}
	if report.Succeeded != 1 {
		t.Fatalf("report = %+v", report)
	}
	if len(requests) != 2 {
		t.Fatalf("requests = %d", len(requests))
	}
	if requests[0][0].URL == "" || requests[1][0].Base64 == "" || requests[1][0].URL != "" {
		t.Fatalf("fallback request = %+v", requests)
	}
	write, _ := writer.get(1)
	if write.Status != "success" || write.Tag != "porn" {
		t.Fatalf("write = %+v", write)
	}
}

func TestEnrichFallbackBudget(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		items := decodeBatch(t, r)
		out := map[string]any{}
		for _, item := range items {
			out[item.UUID] = map[string]any{"success": false, "error": "fetch failed"}
		}
		writeJSON(w, out)
	}))
	defer server.Close()

	writer := newFakeWriter()
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(writer)
	big := make([]byte, 33<<20)
	sources := []domain.GallerySource{gallerySource(1, strPtr("https://img.example/a.png"), big)}
	report, err := edge.Enrich(context.Background(), sources, edgeSettings(server.URL))
	if err != nil {
		t.Fatalf("enrich: %v", err)
	}
	if report.Failed != 1 {
		t.Fatalf("report = %+v", report)
	}
	if requests != 1 {
		t.Fatalf("fallback over budget was sent (%d requests)", requests)
	}
	write, _ := writer.get(1)
	if write.Error == nil || !strings.Contains(*write.Error, "source exceeds batch budget") {
		t.Fatalf("error = %v", write.Error)
	}
}

func TestEnrichOversizeSource(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer server.Close()

	writer := newFakeWriter()
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(writer)
	big := make([]byte, (50<<20)+1)
	if _, err := edge.Enrich(context.Background(),
		[]domain.GallerySource{gallerySource(1, nil, big)}, edgeSettings(server.URL)); err != nil {
		t.Fatalf("enrich: %v", err)
	}
	if called {
		t.Fatal("oversized source was sent")
	}
	write, _ := writer.get(1)
	if write.Error == nil || !strings.Contains(*write.Error, "source exceeds 50 MiB") {
		t.Fatalf("error = %v", write.Error)
	}
}

func TestEnrichBatchFailureMarksAllFailed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()

	writer := newFakeWriter()
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(writer)
	report, err := edge.Enrich(context.Background(), []domain.GallerySource{
		gallerySource(1, strPtr("https://img.example/a.png"), nil),
		gallerySource(2, strPtr("https://img.example/b.png"), nil),
	}, edgeSettings(server.URL))
	if err != nil {
		t.Fatalf("enrich should not fail the whole call: %v", err)
	}
	if report.Failed != 2 || report.Succeeded != 0 {
		t.Fatalf("report = %+v", report)
	}
}

func TestEnrichThumbnailValidation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		items := decodeBatch(t, r)
		out := map[string]any{}
		for _, item := range items {
			out[item.UUID] = map[string]any{"success": true, "data": map[string]any{
				"nsfw":        nsfwJSON(0.9, 0.05),
				"base64":      base64.StdEncoding.EncodeToString([]byte("not-an-image")),
				"contentType": "image/webp",
			}}
		}
		writeJSON(w, out)
	}))
	defer server.Close()

	writer := newFakeWriter()
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(writer)
	if _, err := edge.Enrich(context.Background(), []domain.GallerySource{
		gallerySource(1, strPtr("https://img.example/a.png"), nil),
	}, edgeSettings(server.URL)); err != nil {
		t.Fatalf("enrich: %v", err)
	}
	write, _ := writer.get(1)
	if write.Status != "success" || write.Tag != "safe" {
		t.Fatalf("classification without thumbnail must still succeed: %+v", write)
	}
	if len(write.Thumb) != 0 {
		t.Fatalf("invalid thumbnail stored: %x", write.Thumb)
	}
}

func TestEnrichSkipsOversizedThumbnail(t *testing.T) {
	thumb := testutil.PNG(t, 4, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		items := decodeBatch(t, r)
		out := map[string]any{}
		for _, item := range items {
			out[item.UUID] = map[string]any{"success": true, "data": map[string]any{
				"nsfw":   nsfwJSON(0.9, 0.05),
				"base64": base64.StdEncoding.EncodeToString(thumb), "contentType": "image/png",
			}}
		}
		writeJSON(w, out)
	}))
	defer server.Close()

	writer := newFakeWriter()
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(writer)
	source := domain.GallerySource{ID: 1, SourceURL: strPtr("https://img.example/a.png"), Bytes: 3, HasImage: true, MIME: "image/png"}
	if _, err := edge.Enrich(context.Background(), []domain.GallerySource{source}, edgeSettings(server.URL)); err != nil {
		t.Fatalf("enrich: %v", err)
	}
	write, _ := writer.get(1)
	if len(write.Thumb) != 0 {
		t.Fatalf("thumbnail >= source bytes stored: %d bytes", len(write.Thumb))
	}
	if write.Status != "success" {
		t.Fatalf("write = %+v", write)
	}
}

func TestEnrichBatchesTwentyItems(t *testing.T) {
	var mu sync.Mutex
	var batches [][]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		items := decodeBatch(t, r)
		mu.Lock()
		var uuids []string
		for _, item := range items {
			uuids = append(uuids, item.UUID)
		}
		batches = append(batches, uuids)
		mu.Unlock()
		out := map[string]any{}
		for _, item := range items {
			out[item.UUID] = map[string]any{"success": true, "data": map[string]any{"nsfw": nsfwJSON(0.9, 0.05)}}
		}
		writeJSON(w, out)
	}))
	defer server.Close()

	writer := newFakeWriter()
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(writer)
	sources := make([]domain.GallerySource, 21)
	for i := range sources {
		sources[i] = gallerySource(int64(i+1), strPtr(fmt.Sprintf("https://img.example/%d.png", i)), nil)
	}
	report, err := edge.Enrich(context.Background(), sources, edgeSettings(server.URL))
	if err != nil {
		t.Fatalf("enrich: %v", err)
	}
	if report.Succeeded != 21 {
		t.Fatalf("report = %+v", report)
	}
	if len(batches) != 2 || len(batches[0]) != 20 || len(batches[1]) != 1 {
		t.Fatalf("batches = %v", batches)
	}
}

func TestEnrichDisabled(t *testing.T) {
	writer := newFakeWriter()
	edge := service.NewEdge(nil).WithEnrichmentWriter(writer)
	report, err := edge.Enrich(context.Background(),
		[]domain.GallerySource{gallerySource(1, strPtr("https://img.example/a.png"), nil)}, edgeSettings(""))
	if err != nil || report.Processed != 0 || len(writer.writes) != 0 {
		t.Fatalf("report=%+v err=%v", report, err)
	}
}
