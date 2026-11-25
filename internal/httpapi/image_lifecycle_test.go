package httpapi_test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

type failedImageWriter struct{ header http.Header }

func (w *failedImageWriter) Header() http.Header       { return w.header }
func (w *failedImageWriter) WriteHeader(int)           {}
func (w *failedImageWriter) Write([]byte) (int, error) { return 0, errors.New("client disconnected") }

type contentEnrichment func(context.Context, service.EnrichmentJob) error

func (f contentEnrichment) Run(ctx context.Context, job service.EnrichmentJob) error {
	return f(ctx, job)
}

func TestHTTPWriteFailureStillEnrichesSavedIDs(t *testing.T) {
	ctx := context.Background()
	s, constructErr := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	requireLocalStorage(t, s)
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 2})
	defer tasks.Drain(ctx)
	data := testutil.PNG(t, 4, 4)
	var jobs atomic.Int64
	im := service.NewImages(service.ImageOptions{Tasks: tasks, Delivery: service.NewDelivery(service.DeliveryOptions{Store: s, Downloader: contentDownload(data)}), Subrequest: func(context.Context, int64) (agnes.Generation, error) {
		source := "https://agnes.example/image.png"
		return agnes.Generation{Images: []domain.OutputImage{{URL: &source}}}, nil
	}, Enrichment: contentEnrichment(func(ctx context.Context, job service.EnrichmentJob) error {
		jobs.Add(1)
		if len(job.IDs) != 1 {
			t.Error("wrong saved IDs", job)
		} else if saved, _, err := s.GalleryContent(ctx, job.IDs[0], false); err != nil || !bytes.Equal(saved, data) {
			t.Error("original lost", err)
		}
		return nil
	})})
	handler := httpapi.New(httpapi.Options{Auth: httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret"}), Images: im, Storage: initializedStorage{}, ImageLinks: auth.NewImageLinks("secret", nil), PublicImages: s, Settings: s.ReadSettings})
	req := httptest.NewRequest("POST", "https://proxy.example/v1/images/generations", strings.NewReader(`{"model":"m","prompt":"p"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	handler.ServeHTTP(&failedImageWriter{header: http.Header{}}, req)
	if err := tasks.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListGallery(ctx, domain.CursorQuery{})
	if err != nil || len(page.Items) != 1 || jobs.Load() != 1 || tasks.Pending() != 0 {
		t.Fatalf("write failure lost original/job: %+v %v jobs=%d pending=%d", page, err, jobs.Load(), tasks.Pending())
	}
}

func TestHTTPInvalidPublicOriginDoesNotGenerate(t *testing.T) {
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 2})
	defer tasks.Drain(context.Background())
	var generations atomic.Int64
	im := service.NewImages(service.ImageOptions{Tasks: tasks, Subrequest: func(context.Context, int64) (agnes.Generation, error) {
		generations.Add(1)
		return agnes.Generation{}, nil
	}})
	handler := httpapi.New(httpapi.Options{Auth: httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret"}), Images: im, Storage: initializedStorage{}, ImageLinks: auth.NewImageLinks("secret", nil), Settings: func(context.Context) (domain.Settings, error) { return domain.DefaultSettings(), nil }})
	req := httptest.NewRequest("POST", "http://public.example/v1/images/generations", strings.NewReader(`{"model":"m","prompt":"p"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != 400 || generations.Load() != 0 || tasks.Pending() != 0 {
		t.Fatalf("invalid origin charged: %d generations=%d pending=%d", rec.Code, generations.Load(), tasks.Pending())
	}
}

func TestSignedImageAuthorizationIndependentOfSessions(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)
	sessions := auth.NewSessions("secret", &testEpochs{epoch: 1}, func() time.Time { return now })
	token, err := sessions.Issue(ctx)
	if err != nil {
		t.Fatal(err)
	}
	signer := auth.NewImageLinks("secret", func() time.Time { return now })
	spy := &publicImageSpy{data: testutil.PNG(t, 4, 4), stored: domain.StoredImage{ID: 1, PublicID: "0123456789abcdef0123456789abcdef", MIME: "image/png"}}
	spy.stored.Bytes = int64(len(spy.data))
	handler := httpapi.New(httpapi.Options{Auth: httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret", Sessions: sessions}), ImageLinks: signer, PublicImages: spy})
	link, _ := signer.Issue("https://proxy.example", spy.stored.PublicID, time.Hour)
	parsed, _ := url.Parse(link)
	query := parsed.Query()
	query.Set("signature", strings.Split(token, ".")[1])
	parsed.RawQuery = query.Encode()
	for _, target := range []string{parsed.String(), "https://proxy.example/v1/images/content/" + spy.stored.PublicID} {
		req := httptest.NewRequest("GET", target, nil)
		req.Header.Set("Authorization", "Bearer secret")
		req.AddCookie(&http.Cookie{Name: "agnes_session", Value: token})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != 404 {
			t.Fatal("session/bearer bypassed signature", rec.Code)
		}
	}
	if spy.body != 0 || spy.info != 0 {
		t.Fatal("unauthorized database read")
	}
	if err := sessions.Revoke(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Verify(ctx, token); err == nil {
		t.Fatal("session still valid")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", link, nil))
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), spy.data) {
		t.Fatal("revocation invalidated image link", rec.Code)
	}
}
