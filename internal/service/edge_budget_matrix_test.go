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
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func TestEdgeExactInlineBudgetMatrix(t *testing.T) {
	for _, size := range []int{32 << 20, (32 << 20) + 1, (50 << 20) + 1} {
		for _, mode := range []string{"inline", "url-retry", "mixed"} {
			t.Run(strconv.Itoa(size)+"/"+mode, func(t *testing.T) {
				var data []byte
				if size == 32<<20 {
					data = make([]byte, size)
					copy(data, testutil.PNG(t, 4, 4))
				}
				reads, inlineItems := 0, 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.ContentLength > 46<<20 {
						t.Error("encoded JSON exceeds budget")
					}
					results := map[string]any{}
					for _, item := range decodeBatch(t, r) {
						if mode == "url-retry" && item.URL != "" {
							results[item.UUID] = map[string]any{"status": "error", "error": "fetch failed"}
							continue
						}
						if item.Base64 != "" {
							inlineItems++
							decoded, err := base64.StdEncoding.DecodeString(item.Base64)
							if err != nil || len(decoded) != 32<<20 {
								t.Error("unexpected decoded size", len(decoded), err)
							}
						}
						results[item.UUID] = map[string]any{"status": "ok", "data": map[string]any{"nsfw": map[string]any{"safe": 1, "drawing": 0, "hentai": 0, "porn": 0, "sexy": 0, "isNsfw": false}}}
					}
					writeJSON(w, results)
				}))
				defer server.Close()
				edge := service.NewEdge(server.Client()).WithOriginalReader(originalReadFunc(func(context.Context, int64, bool) ([]byte, string, error) { reads++; return data, "image/png", nil }))
				source := domain.GallerySource{ID: 1, Bytes: int64(size), MIME: "image/png"}
				url := "https://source.example/image.png"
				if mode == "url-retry" {
					source.SourceURL = &url
				}
				sources := []domain.GallerySource{source}
				if mode == "mixed" {
					sources = append(sources, domain.GallerySource{ID: 2, SourceURL: &url, MIME: "image/png", Bytes: 68})
				}
				settings := edgeSettings(server.URL)
				settings.EnrichTimeoutMS = 30000
				report, err := edge.Enrich(context.Background(), sources, settings)
				wantSuccess := 0
				if size == 32<<20 {
					wantSuccess++
				}
				if mode == "mixed" {
					wantSuccess++
				}
				wantReads := 0
				if size == 32<<20 {
					wantReads = 1
				}
				if err != nil || report.Processed != len(sources) || report.Succeeded != wantSuccess || report.Failed != len(sources)-wantSuccess || reads != wantReads || inlineItems != wantReads {
					t.Fatalf("report=%+v err=%v reads=%d inline=%d", report, err, reads, inlineItems)
				}
			})
		}
	}
}
