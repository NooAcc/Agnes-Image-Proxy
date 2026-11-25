package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// GalleryResourceStore reads public local resources without admin credentials.
type GalleryResourceStore interface {
	PublicGalleryResource(context.Context, string, string, bool) (domain.GalleryResource, error)
}

func (r *router) serveGalleryResource(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	fail := func(err error) {
		if req.Method == http.MethodHead {
			var capture headErrorWriter
			capture.header = w.Header()
			apierror.Write(&capture, err)
			w.WriteHeader(capture.status)
			return
		}
		apierror.Write(w, err)
	}
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		methodNotAllowed(w, "GET, HEAD")
		return
	}
	parts := strings.Split(strings.TrimPrefix(req.URL.Path, "/images/"), "/")
	if len(parts) != 2 || req.URL.RawPath != "" || req.URL.RawQuery != "" || req.URL.ForceQuery {
		fail(apierror.Coded(404, "image not found", "invalid_request_error", "not_found"))
		return
	}
	if r.options.GalleryResources == nil {
		fail(apierror.Coded(503, "image unavailable", "server_error", "service_unavailable"))
		return
	}
	result, err := r.options.GalleryResources.PublicGalleryResource(req.Context(), parts[0], parts[1], req.Method == http.MethodHead)
	if err != nil {
		fail(err)
		return
	}
	if _, ok := contentTypes[result.MIME]; !ok || result.Bytes <= 0 {
		fail(apierror.Coded(404, "image not found", "invalid_request_error", "not_found"))
		return
	}
	w.Header().Set("Content-Type", result.MIME)
	w.Header().Set("Content-Length", strconv.FormatInt(result.Bytes, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, parts[1]))
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	if req.Method == http.MethodGet {
		_, _ = w.Write(result.Data)
	}
}

// headErrorWriter preserves API error status and headers without its JSON body.
type headErrorWriter struct {
	header http.Header
	status int
}

func (w *headErrorWriter) Header() http.Header            { return w.header }
func (w *headErrorWriter) WriteHeader(status int)         { w.status = status }
func (w *headErrorWriter) Write(data []byte) (int, error) { return len(data), nil }
