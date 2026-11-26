package httpapi

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

func (r *router) handleGallery(w http.ResponseWriter, req *http.Request, parts []string) {
	switch {
	case len(parts) == 0:
		switch req.Method {
		case http.MethodGet:
			r.listGallery(w, req)
		case http.MethodDelete:
			if err := r.options.Store.ClearGallery(req.Context()); err != nil {
				apierror.Write(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			methodNotAllowed(w, "GET, DELETE")
		}
	case len(parts) == 1 && parts[0] == "enrich":
		r.handleEnrich(w, req)
	case len(parts) == 1:
		id, err := parseAdminID(parts[0])
		if err != nil {
			apierror.Write(w, err)
			return
		}
		if req.Method != http.MethodDelete {
			methodNotAllowed(w, "DELETE")
			return
		}
		deleted, err := r.options.Store.DeleteGallery(req.Context(), id)
		if err != nil {
			apierror.Write(w, err)
			return
		}
		if !deleted {
			apierror.Write(w, apierror.Coded(http.StatusNotFound, "gallery image not found", "invalid_request_error", "not_found"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case len(parts) == 2 && parts[1] == "content":
		r.serveGalleryContent(w, req, parts[0], false)
	case len(parts) == 2 && parts[1] == "thumbnail":
		r.serveGalleryContent(w, req, parts[0], true)
	default:
		adminNotFound(w)
	}
}

func (r *router) listGallery(w http.ResponseWriter, req *http.Request) {
	query, err := parseCursorQuery(req)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	query.RequestID = req.URL.Query().Get("requestId")
	page, err := r.options.Store.ListGallery(req.Context(), query)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	writeAdminJSON(w, http.StatusOK, page)
}

func (r *router) handleEnrich(w http.ResponseWriter, req *http.Request) {
	if r.options.Backfill == nil {
		unavailable(w, "enrichment backfill is unavailable")
		return
	}
	switch req.Method {
	case http.MethodGet:
		writeAdminJSON(w, http.StatusOK, r.options.Backfill.Status())
	case http.MethodPost:
		status, err := r.options.Backfill.Start(req.Context())
		if err != nil {
			apierror.Write(w, err)
			return
		}
		writeAdminJSON(w, http.StatusAccepted, status)
	default:
		methodNotAllowed(w, "GET, POST")
	}
}

var contentTypes = map[string]string{
	"image/png":  "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
}

func (r *router) serveGalleryContent(w http.ResponseWriter, req *http.Request, rawID string, thumbnail bool) {
	if req.Method != http.MethodGet {
		methodNotAllowed(w, "GET")
		return
	}
	id, err := parseAdminID(rawID)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	data, mime, err := r.options.Store.GalleryContent(req.Context(), id, thumbnail)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	ext, ok := contentTypes[strings.ToLower(mime)]
	if !ok || len(data) == 0 {
		apierror.Write(w, apierror.Coded(http.StatusNotFound, "image content not found", "invalid_request_error", "not_found"))
		return
	}
	disposition := "inline"
	if !thumbnail && req.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	prefix := "image"
	if thumbnail {
		prefix = "thumbnail"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`%s; filename="%s-%d.%s"`, disposition, prefix, id, ext))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
