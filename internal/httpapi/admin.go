package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// AdminStore is the persistence boundary for the management API.
type AdminStore interface {
	ListAccounts(ctx context.Context) ([]domain.AccountSummary, error)
	GetAccount(ctx context.Context, id int64) (domain.Account, error)
	CreateAccount(ctx context.Context, name, apiKey string) (domain.AccountSummary, error)
	UpdateAccount(ctx context.Context, id int64, patch domain.AccountPatch) (domain.AccountSummary, error)
	DeleteAccount(ctx context.Context, id int64) (bool, error)
	ResetHealth(ctx context.Context, id int64) (bool, error)
	ReadSettings(ctx context.Context) (domain.Settings, error)
	WriteSettings(ctx context.Context, settings domain.Settings) error
	ListLogs(ctx context.Context, query domain.CursorQuery) (domain.Page[domain.RequestLog], error)
	ClearLogs(ctx context.Context) error
	Overview(ctx context.Context, startDay, endDay string) (domain.Overview, error)
	ListGallery(ctx context.Context, query domain.CursorQuery) (domain.Page[domain.GalleryItem], error)
	GalleryContent(ctx context.Context, id int64, thumbnail bool) ([]byte, string, error)
	DeleteGallery(ctx context.Context, id int64) (bool, error)
	ClearGallery(ctx context.Context) error
}

func (r *router) handleAdmin(w http.ResponseWriter, req *http.Request) {
	path := strings.TrimPrefix(req.URL.Path, "/admin/api/")
	parts := strings.Split(path, "/")
	if parts[0] == "storage" {
		if len(parts) != 1 {
			adminNotFound(w)
			return
		}
		r.handleStorage(w, req)
		return
	}
	if err := r.requireInitialized(req.Context()); err != nil {
		apierror.Write(w, err)
		return
	}
	switch parts[0] {
	case "images":
		if len(parts) != 2 || parts[1] != "generations" {
			adminNotFound(w)
			return
		}
		if req.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		if r.options.Images == nil {
			unavailable(w, "image service is unavailable")
			return
		}
		r.handleImageRequest(w, req)
	case "accounts":
		r.handleAccounts(w, req, parts[1:])
	case "settings":
		if len(parts) != 1 {
			adminNotFound(w)
			return
		}
		r.handleSettings(w, req)
	case "logs":
		if len(parts) != 1 {
			adminNotFound(w)
			return
		}
		r.handleLogs(w, req)
	case "overview":
		if len(parts) != 1 {
			adminNotFound(w)
			return
		}
		r.handleOverview(w, req)
	case "gallery":
		r.handleGallery(w, req, parts[1:])
	default:
		adminNotFound(w)
	}
}

func adminNotFound(w http.ResponseWriter) {
	apierror.Write(w, apierror.Coded(http.StatusNotFound, "not found", "invalid_request_error", "unknown_path"))
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	apierror.Write(w, apierror.Coded(http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed"))
}

func unavailable(w http.ResponseWriter, message string) {
	apierror.Write(w, apierror.Coded(http.StatusServiceUnavailable, message, "server_error", "service_unavailable"))
}

// decodeAdminBody reads one strict JSON object with a 1 MiB cap.
func decodeAdminBody(w http.ResponseWriter, req *http.Request, target any) error {
	req.Body = http.MaxBytesReader(w, req.Body, maxAdminJSONBytes)
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return apierror.Invalid("body", "request body must be a JSON object with known fields", "invalid_value")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return apierror.Invalid("body", "request body must contain exactly one JSON object", "invalid_value")
	}
	return nil
}

func parseAdminID(raw string) (int64, error) {
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, apierror.Invalid("id", "id must be a positive integer", "invalid_value")
	}
	return id, nil
}

func parseCursorQuery(req *http.Request) (domain.CursorQuery, error) {
	query := domain.CursorQuery{}
	values := req.URL.Query()
	if raw := values.Get("before"); raw != "" {
		before, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || before < 0 {
			return domain.CursorQuery{}, apierror.Invalid("before", "before must be a positive cursor", "invalid_value")
		}
		query.Before = &before
	}
	if raw := values.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil {
			return domain.CursorQuery{}, apierror.Invalid("limit", "limit must be an integer", "invalid_value")
		}
		query.Limit = limit
	}
	query.Tag = values.Get("tag")
	query.Category = values.Get("category")
	return query, nil
}

func (r *router) probeSettings(ctx context.Context) (domain.Settings, error) {
	return r.options.Store.ReadSettings(ctx)
}

func (r *router) probeOne(w http.ResponseWriter, req *http.Request, id int64) {
	if r.options.Probe == nil {
		unavailable(w, "probe is unavailable")
		return
	}
	settings, err := r.probeSettings(req.Context())
	if err != nil {
		apierror.Write(w, err)
		return
	}
	result, err := r.options.Probe.One(req.Context(), id, settings)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	writeAdminJSON(w, http.StatusOK, result)
}

func (r *router) probeAll(w http.ResponseWriter, req *http.Request) {
	if r.options.Probe == nil {
		unavailable(w, "probe is unavailable")
		return
	}
	settings, err := r.probeSettings(req.Context())
	if err != nil {
		apierror.Write(w, err)
		return
	}
	results, err := r.options.Probe.All(req.Context(), settings)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	writeAdminJSON(w, http.StatusOK, map[string]any{"items": results})
}
