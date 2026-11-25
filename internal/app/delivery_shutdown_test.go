package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
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
	st, constructErr := store.New(db, nil, t.TempDir())
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = st.Close() })
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
