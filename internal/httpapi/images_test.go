package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

type imageLogs struct {
	mu   sync.Mutex
	logs []domain.RequestLog
}

func (f *imageLogs) RecordRequest(_ context.Context, log domain.RequestLog) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs = append(f.logs, log)
	return nil
}

func (f *imageLogs) snapshot() []domain.RequestLog {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]domain.RequestLog(nil), f.logs...)
}

type imageArchiver struct {
	done chan service.ArchiveJob
}

func (f *imageArchiver) Run(_ context.Context, job service.ArchiveJob) error {
	f.done <- job
	return nil
}

type imageHandlerEnv struct {
	handler  http.Handler
	logs     *imageLogs
	archiver *imageArchiver
}

func newImageHandler(t *testing.T, subrequest func(context.Context, int64) (agnes.Generation, error)) *imageHandlerEnv {
	t.Helper()
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 8})
	logs := &imageLogs{}
	archiver := &imageArchiver{done: make(chan service.ArchiveJob, 8)}
	measurer := &fixedMeasurer{}
	images := service.NewImages(service.ImageOptions{
		Tasks:       tasks,
		Edge:        measurer,
		Archiver:    archiver,
		Logs:        logs,
		Subrequest:  subrequest,
		Workers:     4,
		MaxInFlight: 4,
	})
	sessions := newSessionsForTest(t)
	authn := httpapi.NewAuth(httpapi.AuthOptions{
		APIKey:   "secret-key",
		Sessions: sessions,
		Limiter:  authLimiter(t),
	})
	return &imageHandlerEnv{
		handler: httpapi.New(httpapi.Options{
			Auth:     authn,
			Images:   images,
			Settings: func(context.Context) (domain.Settings, error) { return domain.DefaultSettings(), nil },
			Logs:     logs,
		}),
		logs:     logs,
		archiver: archiver,
	}
}

type fixedMeasurer struct{}

func (f *fixedMeasurer) Measure(_ context.Context, outputs []domain.OutputImage, _ domain.Settings) ([]domain.Measurement, []string) {
	measurements := make([]domain.Measurement, len(outputs))
	for i := range outputs {
		measurements[i] = domain.Measurement{Size: &domain.PixelSize{Width: 864, Height: 1152}, Format: ptrString("png")}
	}
	return measurements, nil
}

func ptrString(value string) *string { return &value }

func imageRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(body))
	req.RemoteAddr = "192.0.2.10:1234"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret-key")
	return req
}

func callHandler(handler http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestImageGenerationUnauthorized(t *testing.T) {
	env := newImageHandler(t, func(context.Context, int64) (agnes.Generation, error) {
		t.Fatal("subrequest ran without authentication")
		return agnes.Generation{}, errors.New("unreachable")
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := callHandler(env.handler, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("missing request id on 401")
	}
	if len(env.logs.snapshot()) != 0 {
		t.Fatalf("unauthorized request logged: %+v", env.logs.snapshot())
	}
}

func TestImageParseErrorLogged(t *testing.T) {
	env := newImageHandler(t, func(context.Context, int64) (agnes.Generation, error) {
		t.Fatal("subrequest ran for an invalid request")
		return agnes.Generation{}, errors.New("unreachable")
	})
	rec := callHandler(env.handler, imageRequest(t, `{"model":"model","prompt":"prompt","size":"not-a-size"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("missing request id")
	}
	logs := env.logs.snapshot()
	if len(logs) != 1 || logs[0].Stage != "parse" || logs[0].Status != http.StatusBadRequest || logs[0].OK {
		t.Fatalf("logs = %+v", logs)
	}
	if logs[0].RequestID == "" {
		t.Fatal("parse log has no request id")
	}
}

func TestImagePartialHTTPResponse(t *testing.T) {
	env := newImageHandler(t, func(ctx context.Context, index int64) (agnes.Generation, error) {
		switch index {
		case 1:
			return agnes.Generation{}, apierror.Coded(502, "upstream error", "server_error", "upstream_error")
		case 3:
			return agnes.Generation{}, apierror.Coded(504, "upstream timeout", "server_error", "upstream_timeout")
		}
		url := "https://img.example/" + itoa64(index) + ".png"
		return agnes.Generation{Images: []domain.OutputImage{{URL: &url}}, AccountID: 7, AccountName: "acct"}, nil
	})
	rec := callHandler(env.handler, imageRequest(t, `{"model":"model","prompt":"prompt","n":5,"size":"1K","response_format":"url"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body service.ImageResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v (%s)", err, rec.Body.String())
	}
	if body.Created == 0 || len(body.Data) != 3 || body.Size != "864x1152" {
		t.Fatalf("body = %+v", body)
	}
	wants := map[string]string{
		"X-Agnes-Requested": "5", "X-Agnes-Succeeded": "3", "X-Agnes-Failed": "2",
		"X-Agnes-Resolved-Size": "1K", "X-Agnes-Failure-Statuses": "502,504",
	}
	for name, want := range wants {
		if got := rec.Header().Get(name); got != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	if !strings.Contains(rec.Header().Get("X-Agnes-Warnings"), "partial-success") {
		t.Fatalf("warnings = %q", rec.Header().Get("X-Agnes-Warnings"))
	}
	select {
	case job := <-env.archiver.done:
		if len(job.Images) != 3 {
			t.Fatalf("archived images = %d", len(job.Images))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("archive not committed after response")
	}
}

func TestImageSingularPath404(t *testing.T) {
	env := newImageHandler(t, func(context.Context, int64) (agnes.Generation, error) {
		t.Fatal("unexpected subrequest")
		return agnes.Generation{}, errors.New("unreachable")
	})
	req := imageRequest(t, `{}`)
	req.URL.Path = "/v1/images/edit"
	rec := callHandler(env.handler, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", rec.Header().Get("Content-Type"))
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("missing request id on 404")
	}
}

func TestModelsAndHealth(t *testing.T) {
	env := newImageHandler(t, func(context.Context, int64) (agnes.Generation, error) {
		return agnes.Generation{}, errors.New("unreachable")
	})

	rec := callHandler(env.handler, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("models status = %d", rec.Code)
	}
	var models struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &models); err != nil || models.Object != "list" || len(models.Data) == 0 {
		t.Fatalf("models = %+v (%v)", models, err)
	}
	rec = callHandler(env.handler, httptest.NewRequest(http.MethodPost, "/v1/models", nil))
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("models POST = %d allow=%q", rec.Code, rec.Header().Get("Allow"))
	}

	rec = callHandler(env.handler, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok"`) {
		t.Fatalf("health = %d %s", rec.Code, rec.Body.String())
	}
}

func TestDeepHealthHidesDatabaseDetails(t *testing.T) {
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 1})
	handler := httpapi.New(httpapi.Options{
		Auth: httpapi.NewAuth(httpapi.AuthOptions{
			APIKey: "secret-key", Sessions: newSessionsForTest(t), Limiter: authLimiter(t),
		}),
		Images:   service.NewImages(service.ImageOptions{Tasks: tasks, Edge: &fixedMeasurer{}, Archiver: &imageArchiver{done: make(chan service.ArchiveJob, 1)}, Logs: &imageLogs{}}),
		Settings: func(context.Context) (domain.Settings, error) { return domain.DefaultSettings(), nil },
		DeepCheck: func(context.Context) error {
			return errors.New("libsql: connection refused to db.turso.io token=super-secret")
		},
	})
	rec := callHandler(handler, httptest.NewRequest(http.MethodGet, "/health?deep=1", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("deep health = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "super-secret") || strings.Contains(rec.Body.String(), "turso") {
		t.Fatalf("database details leaked: %s", rec.Body.String())
	}
}

func TestRootRedirectAndUnknownPath(t *testing.T) {
	env := newImageHandler(t, func(context.Context, int64) (agnes.Generation, error) {
		return agnes.Generation{}, errors.New("unreachable")
	})
	rec := callHandler(env.handler, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/admin" {
		t.Fatalf("root = %d location=%q", rec.Code, rec.Header().Get("Location"))
	}
	rec = callHandler(env.handler, httptest.NewRequest(http.MethodGet, "/v1/unknown", nil))
	if rec.Code != http.StatusNotFound || rec.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("unknown = %d type=%q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("unknown_path")) {
		t.Fatalf("unknown body = %s", rec.Body.String())
	}
}

func itoa64(value int64) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
