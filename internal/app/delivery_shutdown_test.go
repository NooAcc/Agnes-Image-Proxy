package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/imgbed"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/safehttp"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

type gatedOriginal struct {
	data             []byte
	entered, release chan struct{}
}

func (d gatedOriginal) Download(ctx context.Context, _ string) ([]byte, string, error) {
	close(d.entered)
	select {
	case <-d.release:
		return d.data, "image/png", nil
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
}

type gatedResponse struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
}

func (w gatedResponse) Write(data []byte) (int, error) {
	close(w.entered)
	<-w.release
	return w.ResponseRecorder.Write(data)
}

func TestRuntimeShutdownDuringDelivery(t *testing.T) {
	ctx := context.Background()
	data := testutil.PNG(t, 4, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"url":"https://source.example/image.png"}]}`))
	}))
	defer upstream.Close()
	db := testutil.OpenDB(t)
	st, constructErr := store.New(db, store.NewOptions{DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = st.Close() })
	requireLocalStorage(t, st)
	downloader := gatedOriginal{data: data, entered: make(chan struct{}), release: make(chan struct{})}
	rt, err := NewRuntime(Options{Store: st, APIKey: "secret", Downloader: downloader})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Shutdown(ctx)
	settings, err := st.ReadSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings.AgnesBaseURL = upstream.URL
	if err = st.WriteSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateAccount(ctx, "mock", "upstream-key"); err != nil {
		t.Fatal(err)
	}
	writer := gatedResponse{ResponseRecorder: httptest.NewRecorder(), entered: make(chan struct{}), release: make(chan struct{})}
	req := httptest.NewRequest("POST", "https://proxy.example/v1/images/generations", strings.NewReader(`{"model":"m","prompt":"p","response_format":"b64_json"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	requestDone := make(chan struct{})
	go func() { rt.Handler().ServeHTTP(writer, req); close(requestDone) }()
	select {
	case <-downloader.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("delivery not reached")
	}
	// The account success write has finished. Hold an actual SQLite write lock
	// so the next phase is synchronous original persistence, not upstream generation.
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("UPDATE gallery SET prompt = prompt"); err != nil {
		t.Fatal(err)
	}
	close(downloader.release)
	rt.StopAdmission()
	shutdownDone := make(chan error, 1)
	go func() {
		budget, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		shutdownDone <- rt.Shutdown(budget)
	}()
	select {
	case err := <-shutdownDone:
		t.Fatal("shutdown abandoned admitted persistence", err)
	case <-time.After(20 * time.Millisecond):
	}
	if rt.tasks.Pending() != 1 {
		t.Fatal("admitted reservation lost")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-writer.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("save/response did not complete")
	}
	page, err := st.ListGallery(ctx, domain.CursorQuery{})
	if err != nil || len(page.Items) != 1 {
		t.Fatal("original not saved before response", err)
	}
	original, _, err := st.GalleryContent(ctx, page.Items[0].ID, false)
	if err != nil || !bytes.Equal(original, data) {
		t.Fatal("saved original changed", err)
	}
	select {
	case err := <-shutdownDone:
		t.Fatal("shutdown closed store before response handoff", err)
	default:
	}
	close(writer.release)
	<-requestDone
	if err := <-shutdownDone; err != nil {
		t.Fatal(err)
	}
	if writer.Code != 200 || rt.tasks.Pending() != 0 {
		t.Fatal("response/handoff failed", writer.Code, rt.tasks.Pending())
	}
	var response struct {
		Data []struct {
			Base64 string `json:"b64_json"`
		}
	}
	if err := json.Unmarshal(writer.Body.Bytes(), &response); err != nil || len(response.Data) != 1 {
		t.Fatal("response", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(response.Data[0].Base64)
	if err != nil || !bytes.Equal(decoded, data) {
		t.Fatal("delivery bytes", err)
	}
	if err := st.Ping(ctx); err == nil {
		t.Fatal("database not closed after complete handoff")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

type publicResolver struct{}

func (publicResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
}

type staticOriginal struct{ data []byte }

func (d staticOriginal) Download(context.Context, string) ([]byte, string, error) {
	return d.data, "image/png", nil
}

func TestShutdownDrainsImgbedDelivery(t *testing.T) {
	ctx := context.Background()
	data := testutil.PNG(t, 4, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"url":"https://source.example/image.png"}]}`))
	}))
	defer upstream.Close()

	fixed := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	folder := fixed.In(time.FixedZone("CST", 8*60*60)).Format("2006-01-02")
	base := "https://img.example.com"
	readbackEntered := make(chan struct{})
	readbackRelease := make(chan struct{})
	var readbackOnce sync.Once
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch {
		case req.Method == http.MethodPost && req.URL.Path == "/upload":
			body := fmt.Sprintf(`[{"src":%q}]`, base+"/file/agnes-image-proxy/"+folder+"/original.png")
			return responseFor(req, http.StatusOK, "application/json", strings.NewReader(body), -1), nil
		case req.Method == http.MethodGet && strings.HasPrefix(req.URL.Path, "/file/"):
			if req.Header.Get("Authorization") != "" {
				t.Error("read-back leaked the imgbed token")
			}
			readbackOnce.Do(func() { close(readbackEntered) })
			select {
			case <-readbackRelease:
			case <-req.Context().Done():
				return nil, req.Context().Err()
			}
			return responseFor(req, http.StatusOK, "image/png", bytes.NewReader(data), int64(len(data))), nil
		default:
			return responseFor(req, http.StatusNotFound, "text/plain", strings.NewReader("missing"), -1), nil
		}
	})

	db := testutil.OpenDB(t)
	st, constructErr := store.New(db, store.NewOptions{
		DataDir: t.TempDir(),
		Imgbed: imgbed.Options{
			Now:  func() time.Time { return fixed },
			HTTP: safehttp.Options{Resolver: publicResolver{}, Transport: transport},
		},
	})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	url, token := base, "imgbed-token"
	if _, err := st.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageImgbed, ImgbedBaseURL: &url, ImgbedToken: &token}); err != nil {
		t.Fatal(err)
	}

	rt, err := NewRuntime(Options{Store: st, APIKey: "secret", Downloader: staticOriginal{data: data}})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Shutdown(ctx)
	settings, err := st.ReadSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings.AgnesBaseURL = upstream.URL
	if err = st.WriteSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateAccount(ctx, "mock", "upstream-key"); err != nil {
		t.Fatal(err)
	}

	writer := gatedResponse{ResponseRecorder: httptest.NewRecorder(), entered: make(chan struct{}), release: make(chan struct{})}
	req := httptest.NewRequest("POST", "https://proxy.example/v1/images/generations", strings.NewReader(`{"model":"m","prompt":"p","response_format":"b64_json"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	requestDone := make(chan struct{})
	go func() { rt.Handler().ServeHTTP(writer, req); close(requestDone) }()

	select {
	case <-readbackEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("imgbed read-back not reached")
	}
	rt.StopAdmission()
	shutdownDone := make(chan error, 1)
	go func() {
		budget, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		shutdownDone <- rt.Shutdown(budget)
	}()
	select {
	case err := <-shutdownDone:
		t.Fatal("shutdown abandoned admitted remote delivery", err)
	case <-time.After(20 * time.Millisecond):
	}
	if rt.tasks.Pending() != 1 {
		t.Fatal("admitted reservation lost")
	}

	close(readbackRelease)
	select {
	case <-writer.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("imgbed save/response did not complete")
	}
	page, err := st.ListGallery(ctx, domain.CursorQuery{})
	if err != nil || len(page.Items) != 1 {
		t.Fatal("imgbed original not saved before response", err)
	}
	original, mime, err := st.GalleryContent(ctx, page.Items[0].ID, false)
	if err != nil || mime != "image/png" || !bytes.Equal(original, data) {
		t.Fatal("saved imgbed original changed", err, mime)
	}
	select {
	case err := <-shutdownDone:
		t.Fatal("shutdown closed store before response handoff", err)
	default:
	}

	close(writer.release)
	<-requestDone
	if err := <-shutdownDone; err != nil {
		t.Fatal(err)
	}
	if writer.Code != 200 || rt.tasks.Pending() != 0 {
		t.Fatal("response/handoff failed", writer.Code, rt.tasks.Pending())
	}
	if err := st.Ping(ctx); err == nil {
		t.Fatal("database not closed after complete handoff")
	}
}

func responseFor(req *http.Request, status int, contentType string, body io.Reader, length int64) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Status:        fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Body:          io.NopCloser(body),
		ContentLength: length,
		Header:        http.Header{"Content-Type": {contentType}},
		Request:       req,
	}
}
