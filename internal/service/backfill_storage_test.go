package service_test

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func TestBackfillStoredBLOBWorksWithoutURLAndAfterURLFailure(t *testing.T) {
	data := testutil.PNG(t, 64, 64)
	var inline int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		results := map[string]any{}
		for _, item := range decodeBatch(t, r) {
			if item.URL != "" {
				results[item.UUID] = map[string]any{"status": "error", "error": "expired URL"}
				continue
			}
			decoded, err := base64.StdEncoding.DecodeString(item.Base64)
			if err != nil || string(decoded) != string(data) {
				t.Errorf("fallback did not contain stored original")
			}
			inline++
			results[item.UUID] = map[string]any{"status": "ok", "data": map[string]any{"nsfw": map[string]any{"drawing": 0.0, "hentai": 0.0, "safe": 1.0, "porn": 0.0, "sexy": 0.0, "isNsfw": false}}}
		}
		writeJSON(w, results)
	}))
	defer server.Close()
	ctx := context.Background()
	s := store.New(testutil.OpenDB(t), time.Now)
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	mime := "image/png"
	url := "https://expired.example/image.png"
	for _, source := range []*string{nil, &url} {
		if _, err := s.InsertGallery(ctx, domain.GalleryInsert{Image: data, ImageMIME: &mime, SourceURL: source}); err != nil {
			t.Fatal(err)
		}
	}
	edge := service.NewEdge(server.Client()).WithEnrichmentWriter(s)
	backfill := service.NewBackfill(service.BackfillOptions{Store: s, Enricher: edge, Settings: settingsFunc(edgeSettings(server.URL))})
	if _, err := backfill.Start(ctx); err != nil {
		t.Fatal(err)
	}
	status := waitBackfillDone(t, backfill)
	if status.Succeeded != 2 || status.Failed != 0 || inline != 2 {
		t.Fatalf("local BLOB backfill failed: %+v inline=%d", status, inline)
	}
}
