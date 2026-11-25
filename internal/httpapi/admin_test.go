package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

type adminProber struct{ err error }

func requireLocalStorage(t *testing.T, s *store.Store) {
	t.Helper()
	if _, err := s.InitializeStorage(context.Background(), domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		t.Fatalf("initialize local storage: %v", err)
	}
}

func (p adminProber) ProbeModels(context.Context, string, string, time.Duration) error { return p.err }

type noopEnricher struct{}

func (noopEnricher) Enrich(context.Context, []domain.GallerySource, domain.Settings) (service.EnrichReport, error) {
	return service.EnrichReport{}, nil
}

type adminEnv struct {
	handler http.Handler
	store   *store.Store
}

func newAdminEnv(t *testing.T, prober service.Prober) *adminEnv {
	t.Helper()
	db := testutil.OpenDB(t)
	st, constructErr := store.New(db, store.NewOptions{Now: time.Now, DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.EnsureSchema(context.Background()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	requireLocalStorage(t, st)
	sessions := auth.NewSessions("secret-key", st, time.Now)
	limiter := auth.NewLimiter(time.Now)
	authn := httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret-key", Sessions: sessions, Limiter: limiter})
	backfill := service.NewBackfill(service.BackfillOptions{
		Store: st, Enricher: noopEnricher{}, Settings: st.ReadSettings,
	})
	probe := service.NewProbe(service.ProbeOptions{Store: st, Prober: prober, ProbeTimeout: time.Second})
	handler := httpapi.New(httpapi.Options{
		Auth:     authn,
		Store:    st,
		Storage:  st,
		Settings: st.ReadSettings,
		Backfill: backfill,
		Probe:    probe,
		Logs:     st,
	})
	return &adminEnv{handler: handler, store: st}
}

func adminReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "192.0.2.10:1234"
	req.Header.Set("Authorization", "Bearer secret-key")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), target); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
}

func TestAdminAccountsCRUD(t *testing.T) {
	env := newAdminEnv(t, adminProber{})

	rec := callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/accounts", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d %s", rec.Code, rec.Body.String())
	}
	var list struct {
		Items []domain.AccountSummary `json:"items"`
	}
	decodeBody(t, rec, &list)
	if list.Items == nil || len(list.Items) != 0 {
		t.Fatalf("initial list = %+v", list)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache-control = %q", rec.Header().Get("Cache-Control"))
	}

	rec = callHandler(env.handler, adminReq(http.MethodPost, "/admin/api/accounts", `{"name":"primary","apiKey":"sk-123456789012345"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "sk-123456789012345") || strings.Contains(rec.Body.String(), `"apiKey"`) {
		t.Fatalf("create leaked key: %s", rec.Body.String())
	}
	var created domain.AccountSummary
	decodeBody(t, rec, &created)
	if created.ID == 0 || created.Name != "primary" || created.APIKeyMasked == "" || !created.Enabled {
		t.Fatalf("created = %+v", created)
	}

	rec = callHandler(env.handler, adminReq(http.MethodPatch, "/admin/api/accounts/"+itoa64(created.ID), `{"name":"renamed","enabled":false}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch = %d %s", rec.Code, rec.Body.String())
	}
	var patched domain.AccountSummary
	decodeBody(t, rec, &patched)
	if patched.Name != "renamed" || patched.Enabled || patched.Status != domain.AccountDisabled {
		t.Fatalf("patched = %+v", patched)
	}

	rec = callHandler(env.handler, adminReq(http.MethodPatch, "/admin/api/accounts/1", `{"unknown":true}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown field = %d", rec.Code)
	}
	rec = callHandler(env.handler, adminReq(http.MethodPatch, "/admin/api/accounts/abc", `{"name":"x"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid id = %d", rec.Code)
	}

	rec = callHandler(env.handler, adminReq(http.MethodPost, "/admin/api/accounts/"+itoa64(created.ID)+"/test", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("probe one = %d %s", rec.Code, rec.Body.String())
	}
	var probeResult service.ProbeResult
	decodeBody(t, rec, &probeResult)
	if !probeResult.OK || probeResult.ID != created.ID || probeResult.Status != 200 {
		t.Fatalf("probe result = %+v", probeResult)
	}

	rec = callHandler(env.handler, adminReq(http.MethodPost, "/admin/api/accounts/"+itoa64(created.ID)+"/reset", ""))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("reset = %d", rec.Code)
	}
	rec = callHandler(env.handler, adminReq(http.MethodPost, "/admin/api/accounts/999/reset", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing reset = %d", rec.Code)
	}

	rec = callHandler(env.handler, adminReq(http.MethodDelete, "/admin/api/accounts/"+itoa64(created.ID), ""))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete = %d", rec.Code)
	}
	rec = callHandler(env.handler, adminReq(http.MethodDelete, "/admin/api/accounts/"+itoa64(created.ID), ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("double delete = %d", rec.Code)
	}
}

func TestAdminAccountsImportAndProbeAll(t *testing.T) {
	env := newAdminEnv(t, adminProber{})
	body := `{"accounts":[
		{"name":"one","apiKey":"sk-one-1234567890"},
		{"name":"two","apiKey":"sk-two-1234567890"},
		{"name":"","apiKey":"sk-bad"}
	]}`
	rec := callHandler(env.handler, adminReq(http.MethodPost, "/admin/api/accounts/import", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("import = %d %s", rec.Code, rec.Body.String())
	}
	var imported struct {
		Imported int `json:"imported"`
		Errors   []struct {
			Index   int    `json:"index"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	decodeBody(t, rec, &imported)
	if imported.Imported != 2 || len(imported.Errors) != 1 || imported.Errors[0].Index != 2 {
		t.Fatalf("import = %+v", imported)
	}
	if strings.Contains(rec.Body.String(), "sk-one-1234567890") {
		t.Fatal("import response leaked a key")
	}

	rec = callHandler(env.handler, adminReq(http.MethodPost, "/admin/api/accounts/test", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("probe all = %d %s", rec.Code, rec.Body.String())
	}
	var all struct {
		Items []service.ProbeResult `json:"items"`
	}
	decodeBody(t, rec, &all)
	if len(all.Items) != 2 || !all.Items[0].OK || !all.Items[1].OK {
		t.Fatalf("probe items = %+v", all.Items)
	}
	if strings.Contains(rec.Body.String(), "sk-") {
		t.Fatal("probe response leaked a key")
	}

	tooMany := `{"accounts":[` + strings.Repeat(`{"name":"n","apiKey":"sk-key"},`, 1001) + `{"name":"n","apiKey":"sk-key"}]}`
	rec = callHandler(env.handler, adminReq(http.MethodPost, "/admin/api/accounts/import", tooMany))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized import = %d", rec.Code)
	}
}

func TestAdminSettings(t *testing.T) {
	env := newAdminEnv(t, adminProber{})
	rec := callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/settings", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("get settings = %d", rec.Code)
	}
	var settings domain.Settings
	decodeBody(t, rec, &settings)
	if settings.AgnesBaseURL == "" || settings.DefaultSize != "1K" {
		t.Fatalf("settings = %+v", settings)
	}

	settings.ProbeConcurrency = 3
	settings.ImageServiceBaseURL = "https://edge.example"
	encoded, _ := json.Marshal(settings)
	rec = callHandler(env.handler, adminReq(http.MethodPut, "/admin/api/settings", string(encoded)))
	if rec.Code != http.StatusOK {
		t.Fatalf("put settings = %d %s", rec.Code, rec.Body.String())
	}
	var updated domain.Settings
	decodeBody(t, rec, &updated)
	if updated.ProbeConcurrency != 3 || updated.ImageServiceBaseURL != "https://edge.example" {
		t.Fatalf("updated = %+v", updated)
	}

	var raw map[string]any
	_ = json.Unmarshal(encoded, &raw)
	raw["legacyField"] = true
	encoded, _ = json.Marshal(raw)
	rec = callHandler(env.handler, adminReq(http.MethodPut, "/admin/api/settings", string(encoded)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown settings field = %d %s", rec.Code, rec.Body.String())
	}

	settings.ThumbnailWidth = 1
	encoded, _ = json.Marshal(settings)
	rec = callHandler(env.handler, adminReq(http.MethodPut, "/admin/api/settings", string(encoded)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid settings = %d", rec.Code)
	}
}

func TestAdminLogsOverview(t *testing.T) {
	env := newAdminEnv(t, adminProber{})
	ctx := context.Background()
	if err := env.store.RecordRequest(ctx, domain.RequestLog{
		RequestID: "req-1", TS: time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC), Category: "request",
		Stage: "complete", Endpoint: "generations", Model: "model", Status: 200, OK: true,
		Requested: 2, Images: 2,
	}); err != nil {
		t.Fatalf("seed log: %v", err)
	}

	rec := callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/logs?category=request&limit=10", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("logs = %d %s", rec.Code, rec.Body.String())
	}
	var page domain.Page[domain.RequestLog]
	decodeBody(t, rec, &page)
	if len(page.Items) != 1 || page.Items[0].RequestID != "req-1" {
		t.Fatalf("log page = %+v", page)
	}
	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/logs?category=nope", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid category = %d", rec.Code)
	}

	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/overview?start=2026-11-24&end=2026-11-24", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("overview = %d %s", rec.Code, rec.Body.String())
	}
	var overview domain.Overview
	decodeBody(t, rec, &overview)
	if overview.Totals.Requests != 1 || overview.Totals.Images != 2 {
		t.Fatalf("overview = %+v", overview)
	}
	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/overview?start=2026-11-24&end=2026-11-20", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid range = %d", rec.Code)
	}

	rec = callHandler(env.handler, adminReq(http.MethodDelete, "/admin/api/logs", ""))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("clear logs = %d", rec.Code)
	}
	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/logs", ""))
	decodeBody(t, rec, &page)
	if len(page.Items) != 0 {
		t.Fatalf("logs after clear = %+v", page)
	}
}

func TestAdminGalleryAndContent(t *testing.T) {
	env := newAdminEnv(t, adminProber{})
	ctx := context.Background()
	pngBytes := testutil.PNG(t, 4, 4)
	id, err := env.store.InsertGallery(ctx, domain.GalleryInsert{
		OutputKey: "req-g:0:0",
		RequestID: "req-g", Model: "model", Prompt: "prompt", SizeRequest: "1K",
		Image: pngBytes, ImageMIME: ptrString("image/png"),
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}

	rec := callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/gallery", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("gallery = %d %s", rec.Code, rec.Body.String())
	}
	var page domain.Page[domain.GalleryItem]
	decodeBody(t, rec, &page)
	if len(page.Items) != 1 || page.Items[0].ID != id {
		t.Fatalf("gallery page = %+v", page)
	}
	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/gallery?tag=bogus", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid tag = %d", rec.Code)
	}

	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/gallery/"+itoa64(id)+"/content", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("content = %d", rec.Code)
	}
	if rec.Header().Get("Content-Type") != "image/png" || rec.Header().Get("X-Content-Type-Options") != "nosniff" ||
		!strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("content headers = %v", rec.Header())
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Disposition"), "inline;") {
		t.Fatalf("disposition = %q", rec.Header().Get("Content-Disposition"))
	}
	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/gallery/"+itoa64(id)+"/content?download=1", ""))
	if !strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment;") ||
		!strings.Contains(rec.Header().Get("Content-Disposition"), ".png") {
		t.Fatalf("download disposition = %q", rec.Header().Get("Content-Disposition"))
	}

	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/gallery/"+itoa64(id)+"/thumbnail", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing thumbnail = %d (must not fall back to original)", rec.Code)
	}

	// Enrichment is disabled until the image service is configured.
	rec = callHandler(env.handler, adminReq(http.MethodPost, "/admin/api/gallery/enrich", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("disabled enrich = %d %s", rec.Code, rec.Body.String())
	}
	settings, _ := env.store.ReadSettings(ctx)
	settings.ImageServiceBaseURL = "https://edge.example"
	if err := env.store.WriteSettings(ctx, settings); err != nil {
		t.Fatalf("settings: %v", err)
	}
	rec = callHandler(env.handler, adminReq(http.MethodPost, "/admin/api/gallery/enrich", ""))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("enrich start = %d %s", rec.Code, rec.Body.String())
	}
	var status service.BackfillStatus
	decodeBody(t, rec, &status)
	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/gallery/enrich", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("enrich status = %d", rec.Code)
	}
	decodeBody(t, rec, &status)

	rec = callHandler(env.handler, adminReq(http.MethodDelete, "/admin/api/gallery/"+itoa64(id), ""))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete gallery = %d", rec.Code)
	}
	rec = callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/gallery/"+itoa64(id)+"/content", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("content after delete = %d", rec.Code)
	}
	rec = callHandler(env.handler, adminReq(http.MethodDelete, "/admin/api/gallery", ""))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("clear gallery = %d", rec.Code)
	}
}

func TestAdminUnknownRoutesAndMethods(t *testing.T) {
	env := newAdminEnv(t, adminProber{})
	rec := callHandler(env.handler, adminReq(http.MethodGet, "/admin/api/nope", ""))
	if rec.Code != http.StatusNotFound || rec.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("unknown = %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	rec = callHandler(env.handler, adminReq(http.MethodPut, "/admin/api/accounts", `{}`))
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, POST" {
		t.Fatalf("method = %d allow=%q", rec.Code, rec.Header().Get("Allow"))
	}
	req := httptest.NewRequest(http.MethodGet, "/admin/api/accounts", nil)
	rec = callHandler(env.handler, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous admin = %d", rec.Code)
	}
}
