package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

type PublicImageStore interface {
	PublicImageInfo(context.Context, string) (domain.StoredImage, error)
	PublicImageContent(context.Context, string) ([]byte, string, error)
}

func (r *router) servePublicImage(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.options.Auth != nil {
		r.options.Auth.corsHeaders(w, req)
	}
	if req.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(204)
		return
	}
	fail := func(status int) {
		message, code := "image not found", "not_found"
		if status == 503 {
			message, code = "image unavailable", "service_unavailable"
		}
		if req.Method == "HEAD" {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(status)
			return
		}
		apierror.Write(w, apierror.Coded(status, message, "invalid_request_error", code))
	}
	if req.Method != "GET" && req.Method != "HEAD" {
		methodNotAllowed(w, "GET, HEAD, OPTIONS")
		return
	}
	id := strings.TrimPrefix(req.URL.Path, "/v1/images/content/")
	query, err := url.ParseQuery(req.URL.RawQuery)
	if err != nil || strings.Contains(id, "/") || r.options.ImageLinks == nil {
		fail(404)
		return
	}
	if _, err := r.options.ImageLinks.Verify(id, query); err != nil {
		fail(404)
		return
	}
	if r.options.PublicImages == nil {
		fail(503)
		return
	}
	var mime string
	var length int64
	var data []byte
	if req.Method == "HEAD" {
		info, readErr := r.options.PublicImages.PublicImageInfo(req.Context(), id)
		err = readErr
		mime, length = info.MIME, info.Bytes
	} else {
		data, mime, err = r.options.PublicImages.PublicImageContent(req.Context(), id)
		length = int64(len(data))
	}
	if err != nil {
		var ae *apierror.Error
		if errors.As(err, &ae) && ae.Status == 404 {
			fail(404)
		} else {
			fail(503)
		}
		return
	}
	ext, ok := contentTypes[mime]
	if !ok || length <= 0 {
		fail(404)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="image-%s.%s"`, id, ext))
	w.WriteHeader(200)
	if req.Method == "GET" {
		_, _ = w.Write(data)
	}
}
