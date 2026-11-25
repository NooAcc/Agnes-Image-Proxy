package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func newUninitializedHandler(t *testing.T, storage httpapi.StorageStore) (http.Handler, *store.Store) {
	t.Helper()
	st, _ := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	t.Cleanup(func() { _ = st.Close() })
	if err := st.EnsureSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessions("secret-key", st, time.Now)
	authn := httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret-key", Sessions: sessions, Limiter: auth.NewLimiter(time.Now)})
	settingsCalls := 0
	handler := httpapi.New(httpapi.Options{
		Auth:     authn,
		Store:    st,
		Storage:  storage,
		Settings: func(context.Context) (domain.Settings, error) { settingsCalls++; return domain.DefaultSettings(), nil },
		Images:   service.NewImages(service.ImageOptions{}),
		Logs:     st,
		Assets: httpapi.NewAssets(fstest.MapFS{
			"index.html": {Data: []byte("<html>console</html>")},
			"login.html": {Data: []byte("<html>login</html>")},
			"setup.html": {Data: []byte("<html>setup</html>")},
		}),
	})
	t.Cleanup(func() {
		if settingsCalls != 0 {
			t.Errorf("settings were read before the initialization gate")
		}
	})
	return handler, st
}

type failingStorage struct{ err error }

func (f failingStorage) StorageStatus(context.Context) (domain.StorageStatus, error) {
	return domain.StorageStatus{}, f.err
}
func (f failingStorage) InitializeStorage(context.Context, domain.StorageInit) (domain.StorageStatus, error) {
	return domain.StorageStatus{}, f.err
}
func (f failingStorage) UpdateImgbedStorage(context.Context, domain.StorageUpdate) (domain.StorageStatus, error) {
	return domain.StorageStatus{}, f.err
}

func TestInitializationGatesBeforeAnyRemoteWork(t *testing.T) {
	handler := buildUninitialized(t)

	for _, path := range []string{
		"/admin/api/accounts",
		"/admin/api/settings",
		"/admin/api/logs",
		"/admin/api/overview",
		"/admin/api/gallery",
	} {
		rec := callHandler(handler, adminReq(http.MethodGet, path, ""))
		if status, code, _ := adminJSON(t, rec); status != 503 || code != "initialization_required" {
			t.Fatalf("%s = %d %q", path, status, code)
		}
	}

	rec := callHandler(handler, adminReq(http.MethodPost, "/v1/images/generations", `{"model":"m","prompt":"p"}`))
	if status, code, _ := adminJSON(t, rec); status != 503 || code != "initialization_required" {
		t.Fatalf("generations = %d %q", status, code)
	}
	rec = callHandler(handler, adminReq(http.MethodPost, "/v1/images/edits", `{"model":"m","prompt":"p"}`))
	if status, code, _ := adminJSON(t, rec); status != 503 || code != "initialization_required" {
		t.Fatalf("edits = %d %q", status, code)
	}

	// Allowed surfaces.
	if rec := callHandler(handler, adminReq(http.MethodGet, "/admin/api/storage", "")); rec.Code != 200 {
		t.Fatalf("storage = %d", rec.Code)
	}
	if rec := callHandler(handler, adminReq(http.MethodGet, "/admin/api/session", "")); rec.Code != 200 {
		t.Fatalf("session = %d", rec.Code)
	}
	if rec := callHandler(handler, httptest.NewRequest(http.MethodGet, "/health", nil)); rec.Code != 200 {
		t.Fatalf("health = %d", rec.Code)
	}
	if rec := callHandler(handler, httptest.NewRequest(http.MethodGet, "/v1/models", nil)); rec.Code != 200 {
		t.Fatalf("models = %d", rec.Code)
	}
	if rec := callHandler(handler, httptest.NewRequest(http.MethodGet, "/admin/setup", nil)); rec.Code != 200 || !strings.Contains(rec.Body.String(), "setup") {
		t.Fatalf("setup asset = %d %s", rec.Code, rec.Body.String())
	}

	options := httptest.NewRequest(http.MethodOptions, "/v1/images/generations", nil)
	options.Header.Set("Origin", "https://client.example")
	if rec := callHandler(handler, options); rec.Code != 204 {
		t.Fatalf("OPTIONS = %d", rec.Code)
	}
	unauthenticated := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{}`))
	if rec := callHandler(handler, unauthenticated); rec.Code != 401 {
		t.Fatalf("unauthenticated POST = %d", rec.Code)
	}

	// A database failure is not reported as "needs initialization".
	broken, _ := newUninitializedHandler(t, failingStorage{err: apierror.Coded(503, "database unavailable", "server_error", "database_unavailable")})
	rec = callHandler(broken, adminReq(http.MethodGet, "/admin/api/accounts", ""))
	if status, code, _ := adminJSON(t, rec); status != 503 || code != "database_unavailable" {
		t.Fatalf("database failure = %d %q", status, code)
	}

	// A missing dependency is unavailable, never implicitly initialized.
	missing, _ := newUninitializedHandler(t, nil)
	rec = callHandler(missing, adminReq(http.MethodGet, "/admin/api/accounts", ""))
	if status, code, _ := adminJSON(t, rec); status != 503 || code != "service_unavailable" {
		t.Fatalf("missing storage dependency = %d %q", status, code)
	}
}

func buildUninitialized(t *testing.T) http.Handler {
	t.Helper()
	s, _ := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessions("secret-key", s, time.Now)
	authn := httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret-key", Sessions: sessions, Limiter: auth.NewLimiter(time.Now)})
	settingsCalls := 0
	handler := httpapi.New(httpapi.Options{
		Auth:     authn,
		Store:    s,
		Storage:  s,
		Settings: func(context.Context) (domain.Settings, error) { settingsCalls++; return domain.DefaultSettings(), nil },
		Images:   service.NewImages(service.ImageOptions{}),
		Logs:     s,
		Assets: httpapi.NewAssets(fstest.MapFS{
			"index.html": {Data: []byte("<html>console</html>")},
			"login.html": {Data: []byte("<html>login</html>")},
			"setup.html": {Data: []byte("<html>setup</html>")},
		}),
	})
	t.Cleanup(func() {
		if settingsCalls != 0 {
			t.Errorf("settings were read before the initialization gate")
		}
	})
	return handler
}
