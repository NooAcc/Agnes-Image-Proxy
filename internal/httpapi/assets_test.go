package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
)

func assetsFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":               &fstest.MapFile{Data: []byte("<!doctype html><title>Agnes 控制台</title>")},
		"assets/index-DiwrgTda.js": &fstest.MapFile{Data: []byte("console.log(1)")},
		"assets/index-Bj4xY8mP.css": &fstest.MapFile{
			Data: []byte("body{}"),
		},
		"favicon.svg": &fstest.MapFile{Data: []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")},
	}
}

func serve(t *testing.T, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	handler := httpapi.NewAssets(assetsFS())
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestAssetsServesPages(t *testing.T) {
	for _, path := range []string{"/admin", "/admin/", "/admin/overview", "/admin/gallery", "/admin/accounts", "/admin/logs", "/admin/settings", "/admin/setup", "/admin/login"} {
		rec := serve(t, http.MethodGet, path)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "Agnes 控制台") {
			t.Fatalf("%s did not return index", path)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("%s content type = %q", path, ct)
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
			t.Fatalf("%s cache control = %q", path, cc)
		}
		csp := rec.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "script-src 'self'") || strings.Contains(csp, "unsafe-inline") && !strings.Contains(csp, "style-src-attr 'unsafe-inline'") {
			t.Fatalf("%s CSP = %q", path, csp)
		}
		if rec.Header().Get("X-Frame-Options") != "DENY" {
			t.Fatalf("%s missing frame protection", path)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s missing nosniff", path)
		}
	}
}

func TestAssetsServesHashedFilesImmutable(t *testing.T) {
	rec := serve(t, http.MethodGet, "/admin/assets/index-DiwrgTda.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Body.String() != "console.log(1)" {
		t.Fatalf("body = %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("content type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("cache control = %q", cc)
	}
}

func TestAssetsMissingFileIsJSON404(t *testing.T) {
	rec := serve(t, http.MethodGet, "/admin/assets/missing.js")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "<!doctype") {
		t.Fatal("missing asset fell back to index.html")
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("not json: %v (%s)", err, rec.Body.String())
	}
}

func TestAssetsUnknownAPIIsJSON404(t *testing.T) {
	rec := serve(t, http.MethodGet, "/admin/api/unknown")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "<!doctype") {
		t.Fatal("unknown API fell back to index.html")
	}
}

func TestAssetsUnknownPageIs404(t *testing.T) {
	rec := serve(t, http.MethodGet, "/admin/not-a-page")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "<!doctype") {
		t.Fatal("unknown page fell back to index.html")
	}
}

func TestAssetsRejectsTraversal(t *testing.T) {
	for _, path := range []string{
		"/admin/assets/../../secret.txt",
		"/admin/assets/%2e%2e/%2e%2e/secret.txt",
		"/admin/assets/..%2fsecret.txt",
	} {
		rec := serve(t, http.MethodGet, path)
		if rec.Code == http.StatusOK {
			t.Fatalf("%s served content (%d)", path, rec.Code)
		}
	}
}

func TestAssetsHeadHasNoBody(t *testing.T) {
	rec := serve(t, http.MethodHead, "/admin/assets/index-DiwrgTda.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD body = %q", rec.Body.String())
	}
}

func TestAssetsRejectsNonGET(t *testing.T) {
	rec := serve(t, http.MethodPost, "/admin/gallery")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", rec.Code)
	}
}
