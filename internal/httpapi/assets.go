package httpapi

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
)

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; " +
	"style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; " +
	"connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; " +
	"frame-ancestors 'none'"

var pageRoutes = map[string]bool{
	"/admin":          true,
	"/admin/":         true,
	"/admin/overview": true,
	"/admin/gallery":  true,
	"/admin/accounts": true,
	"/admin/logs":     true,
	"/admin/settings": true,
	"/admin/login":    true,
}

var hashedAsset = regexp.MustCompile(`[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$`)

type assetsHandler struct {
	fsys fs.FS
}

// NewAssets serves the admin SPA and its static assets. Only known page routes
// fall back to index.html; missing files and unknown pages return JSON 404s.
func NewAssets(fsys fs.FS) http.Handler {
	return &assetsHandler{fsys: fsys}
}

func (h *assetsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, r, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	raw := r.URL.Path
	cleaned := path.Clean(raw)
	if cleaned != raw && cleaned+"/" != raw {
		writeJSON(w, r, http.StatusNotFound, "not found")
		return
	}
	if cleaned == "/admin/api" || strings.HasPrefix(cleaned, "/admin/api/") {
		writeJSON(w, r, http.StatusNotFound, "not found")
		return
	}

	if pageRoutes[cleaned] {
		h.serveIndex(w, r)
		return
	}

	file := strings.TrimPrefix(cleaned, "/admin/")
	if !strings.HasPrefix(cleaned, "/admin/") || !fs.ValidPath(file) || file == "." {
		writeJSON(w, r, http.StatusNotFound, "not found")
		return
	}
	h.serveFile(w, r, file)
}

func (h *assetsHandler) serveIndex(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(h.fsys, "index.html")
	if err != nil {
		writeJSON(w, r, http.StatusInternalServerError, "console build missing")
		return
	}
	header := w.Header()
	header.Set("Content-Type", "text/html; charset=utf-8")
	header.Set("Cache-Control", "no-store")
	header.Set("Content-Security-Policy", contentSecurityPolicy)
	header.Set("X-Frame-Options", "DENY")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

func (h *assetsHandler) serveFile(w http.ResponseWriter, r *http.Request, name string) {
	info, err := fs.Stat(h.fsys, name)
	if err != nil || info.IsDir() {
		writeJSON(w, r, http.StatusNotFound, "not found")
		return
	}
	data, err := fs.ReadFile(h.fsys, name)
	if err != nil {
		writeJSON(w, r, http.StatusNotFound, "not found")
		return
	}

	header := w.Header()
	header.Set("Content-Type", contentTypeFor(name))
	if hashedAsset.MatchString(path.Base(name)) {
		header.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		header.Set("Cache-Control", "public, max-age=0, must-revalidate")
	}
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

type jsonError struct {
	Error struct {
		Message string  `json:"message"`
		Type    string  `json:"type"`
		Param   *string `json:"param"`
		Code    *string `json:"code"`
	} `json:"error"`
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	var payload jsonError
	payload.Error.Message = message
	payload.Error.Type = "invalid_request_error"
	payload.Error.Code = ptr("not_found")
	_ = json.NewEncoder(w).Encode(payload)
}

func contentTypeFor(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".txt":
		return "text/plain; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

func ptr[T any](v T) *T { return &v }
