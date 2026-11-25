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
		"login.html":               &fstest.MapFile{Data: []byte("<!doctype html><title>Agnes 登录页</title>")},
		"setup.html":               &fstest.MapFile{Data: []byte("<!doctype html><title>Agnes 初始化</title>")},
		"assets/index-DiwrgTda.js": &fstest.MapFile{Data: []byte("console.log(1)")},
		"assets/index-Bj4xY8mP.css": &fstest.MapFile{
			Data: []byte("body{}"),
		},
		"favicon.svg": &fstest.MapFile{Data: []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")},
	}
}

func serve(t *testing.T, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	return serveFS(t, assetsFS(), method, target)
}

func serveFS(t *testing.T, fsys fstest.MapFS, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	httpapi.NewAssets(fsys).ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestAssetsServesPages(t *testing.T) {
	pages := map[string]string{
		"/admin":          "Agnes 控制台",
		"/admin/":         "Agnes 控制台",
		"/admin/overview": "Agnes 控制台",
		"/admin/gallery":  "Agnes 控制台",
		"/admin/accounts": "Agnes 控制台",
		"/admin/logs":     "Agnes 控制台",
		"/admin/settings": "Agnes 控制台",
		"/admin/login":    "Agnes 登录页",
		"/admin/setup":    "Agnes 初始化",
	}
	for path, marker := range pages {
		rec := serve(t, http.MethodGet, path)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), marker) {
			t.Fatalf("%s did not return %q", path, marker)
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

func TestAssetsServesDistinctDocuments(t *testing.T) {
	for _, tc := range []struct{ path, marker string }{
		{"/admin/login", "Agnes 登录页"},
		{"/admin/setup", "Agnes 初始化"},
		{"/admin/settings", "Agnes 控制台"},
	} {
		body := serve(t, http.MethodGet, tc.path).Body.String()
		if !strings.Contains(body, tc.marker) {
			t.Fatalf("%s did not serve %q: %q", tc.path, tc.marker, body)
		}
		for _, other := range []string{"Agnes 控制台", "Agnes 登录页", "Agnes 初始化"} {
			if other != tc.marker && strings.Contains(body, other) {
				t.Fatalf("%s served the wrong document %q", tc.path, other)
			}
		}
	}
}

func TestAssetsMissingPageDocumentIs500(t *testing.T) {
	fsys := assetsFS()
	delete(fsys, "login.html")
	rec := serveFS(t, fsys, http.MethodGet, "/admin/login")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "<!doctype") {
		t.Fatal("missing login document fabricated HTML")
	}
}

func TestAssetsPageHeadHasNoBody(t *testing.T) {
	for _, path := range []string{"/admin", "/admin/login", "/admin/setup"} {
		rec := serve(t, http.MethodHead, path)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s HEAD status = %d", path, rec.Code)
		}
		if rec.Body.Len() != 0 {
			t.Fatalf("%s HEAD body = %q", path, rec.Body.String())
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
