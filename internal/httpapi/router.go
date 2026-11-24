package httpapi

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

const maxDataBodyBytes = 32 << 20

var defaultModels = []string{"agnes-image-2.5-flash", "agnes-image-2.1-flash"}

// Options wires the HTTP boundary. The administration routes are enabled when
// Store and Auth are both set.
type Options struct {
	Auth      *Auth
	Images    *service.Images
	Store     AdminStore
	Backfill  *service.Backfill
	Probe     *service.Probe
	Settings  func(context.Context) (domain.Settings, error)
	Reference images.ReferenceReader
	Logs      service.RequestLogStore
	Assets    http.Handler
	DeepCheck func(context.Context) error
	Models    []string
}

type router struct {
	options  Options
	models   []string
	data     http.Handler
	sessions http.Handler
	admin    http.Handler
}

// New builds the HTTP router.
func New(options Options) http.Handler {
	models := options.Models
	if len(models) == 0 {
		models = defaultModels
	}
	if options.Reference == nil {
		options.Reference = unavailableReference{}
	}
	r := &router{options: options, models: models}
	if options.Auth != nil {
		r.sessions = options.Auth.SessionHandler()
		if options.Images != nil {
			r.data = options.Auth.Data(http.HandlerFunc(r.handleImageRequest))
		}
		if options.Store != nil {
			r.admin = options.Auth.Admin(http.HandlerFunc(r.handleAdmin))
		}
	}
	return r
}

func (r *router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	requestID := newRequestID()
	w.Header().Set("X-Request-ID", requestID)

	path := req.URL.Path
	switch {
	case path == "/":
		w.Header().Set("Location", "/admin")
		w.WriteHeader(http.StatusFound)
	case path == "/health":
		r.handleHealth(w, req)
	case path == "/v1/models":
		r.handleModels(w, req)
	case path == "/v1/images/generations" || path == "/v1/images/edits":
		if req.Method != http.MethodPost && req.Method != http.MethodOptions {
			w.Header().Set("Allow", "POST, OPTIONS")
			apierror.Write(w, apierror.Coded(http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed"))
			return
		}
		if r.data == nil {
			apierror.Write(w, apierror.Coded(http.StatusServiceUnavailable, "image service is unavailable", "server_error", "service_unavailable"))
			return
		}
		r.data.ServeHTTP(w, req)
	case path == "/admin/api/session" || path == "/admin/api/session/revoke":
		if r.sessions == nil {
			apierror.Write(w, apierror.Coded(http.StatusNotFound, "not found", "invalid_request_error", "unknown_path"))
			return
		}
		r.sessions.ServeHTTP(w, req)
	case strings.HasPrefix(path, "/admin/api/"):
		if r.admin == nil {
			apierror.Write(w, apierror.Coded(http.StatusNotFound, "not found", "invalid_request_error", "unknown_path"))
			return
		}
		r.admin.ServeHTTP(w, req)
	case strings.HasPrefix(path, "/admin") && r.options.Assets != nil:
		r.options.Assets.ServeHTTP(w, req)
	default:
		apierror.Write(w, apierror.Coded(http.StatusNotFound, "not found", "invalid_request_error", "unknown_path"))
	}
}

func (r *router) handleHealth(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		apierror.Write(w, apierror.Coded(http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed"))
		return
	}
	if req.URL.Query().Get("deep") == "1" && r.options.DeepCheck != nil {
		ctx, cancel := context.WithTimeout(req.Context(), 15*time.Second)
		defer cancel()
		if err := r.options.DeepCheck(ctx); err != nil {
			apierror.Write(w, apierror.Coded(http.StatusServiceUnavailable, "database unavailable", "server_error", "database_unavailable"))
			return
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if req.Method != http.MethodHead {
		_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
	}
}

type modelEntry struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

func (r *router) handleModels(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		apierror.Write(w, apierror.Coded(http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed"))
		return
	}
	entries := make([]modelEntry, 0, len(r.models))
	for _, id := range r.models {
		entries = append(entries, modelEntry{ID: id, Object: "model", Created: 0, OwnedBy: "agnes"})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if req.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": entries})
	}
}

func (r *router) handleImageRequest(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	requestID := w.Header().Get("X-Request-Id")
	if r.options.Settings == nil {
		apierror.Write(w, apierror.Coded(http.StatusServiceUnavailable, "settings are unavailable", "server_error", "service_unavailable"))
		return
	}
	settings, err := r.options.Settings(ctx)
	if err != nil {
		apierror.Write(w, err)
		return
	}

	req.Body = http.MaxBytesReader(w, req.Body, maxDataBodyBytes)
	parsed, parseErr := images.Parse(ctx, req, settings, r.options.Reference)
	if parseErr != nil {
		r.recordParseFailure(ctx, req, requestID, parseErr)
		apierror.Write(w, parseErr)
		return
	}

	result, err := r.options.Images.Generate(ctx, parsed, settings, requestID)
	if err != nil {
		apierror.Write(w, err)
		return
	}

	for name, values := range result.Headers {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(result.Response)

	// Hand off archive capacity even when the response write failed; the
	// successful images must not be dropped because the client went away.
	_ = result.CommitArchive()
}

// recordParseFailure logs a rejected request. It never uses the client
// request's cancellation and never changes the response.
func (r *router) recordParseFailure(ctx context.Context, req *http.Request, requestID string, parseErr error) {
	if r.options.Logs == nil {
		return
	}
	status := http.StatusInternalServerError
	var apiErr *apierror.Error
	if errors.As(parseErr, &apiErr) {
		status = apiErr.Status
	}
	endpoint := "generations"
	if strings.HasSuffix(strings.TrimRight(req.URL.Path, "/"), "/edits") {
		endpoint = "edits"
	}
	log := domain.RequestLog{
		RequestID:  requestID,
		TS:         time.Now().UTC(),
		Category:   "request",
		Stage:      "parse",
		Endpoint:   endpoint,
		Path:       req.URL.Path,
		Status:     status,
		OK:         false,
		DurationMS: 0,
	}
	logCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	_ = r.options.Logs.RecordRequest(logCtx, log)
}

func newRequestID() string {
	var buf [16]byte
	if _, err := crand.Read(buf[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(buf[:])
}

type unavailableReference struct{}

func (unavailableReference) Dimensions(context.Context, string) (domain.PixelSize, error) {
	return domain.PixelSize{}, apierror.Invalid("size", "reference image size is unavailable", "invalid_value")
}
