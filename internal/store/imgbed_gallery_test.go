package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/imgbed"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/safehttp"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

type publicResolver struct{}

func (publicResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
}

func imgbedNow() time.Time { return time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC) }

func imgbedAPICode(t *testing.T, err error) (int, string) {
	t.Helper()
	var apiErr *apierror.Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected API error, got %T: %v", err, err)
	}
	code := ""
	if apiErr.Code != nil {
		code = *apiErr.Code
	}
	return apiErr.Status, code
}

type fakeImgbed struct {
	mu           sync.Mutex
	data         []byte
	delay        time.Duration
	readBlock    chan struct{}
	uploads      int
	reads        int
	heads        int
	deletes      int
	deleteFailAt int
	deleteBody   string
	uploadAuth   []string
	uploadHost   []string
	readAuth     []string
	deleteAuth   []string
	deletePath   []string
}

func (f *fakeImgbed) RoundTrip(r *http.Request) (*http.Response, error) {
	f.mu.Lock()
	delay := f.delay
	block := f.readBlock
	f.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/upload":
		filename := multipartFilename(r)
		f.mu.Lock()
		f.uploads++
		f.uploadAuth = append(f.uploadAuth, r.Header.Get("Authorization"))
		f.uploadHost = append(f.uploadHost, r.URL.Host)
		f.mu.Unlock()
		src := r.URL.Scheme + "://" + r.URL.Host + "/file/" + r.URL.Query().Get("uploadFolder") + "/" + filename
		return jsonResponse(200, `[{"src":"`+src+`"}]`), nil
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/file/"):
		f.mu.Lock()
		f.reads++
		f.readAuth = append(f.readAuth, r.Header.Get("Authorization"))
		data := f.data
		f.mu.Unlock()
		if block != nil {
			<-block
		}
		return binaryResponse(200, "image/png", data), nil
	case r.Method == http.MethodHead && strings.HasPrefix(r.URL.Path, "/file/"):
		f.mu.Lock()
		f.heads++
		data := f.data
		f.mu.Unlock()
		return &http.Response{
			StatusCode:    200,
			Header:        http.Header{"Content-Type": {"image/png"}},
			Body:          io.NopCloser(strings.NewReader("")),
			ContentLength: int64(len(data)),
			Request:       r,
		}, nil
	case strings.HasPrefix(r.URL.Path, "/api/manage/delete/"):
		f.mu.Lock()
		f.deletes++
		f.deleteAuth = append(f.deleteAuth, r.Header.Get("Authorization"))
		f.deletePath = append(f.deletePath, r.URL.EscapedPath())
		failAt := f.deleteFailAt
		count := f.deletes
		body := f.deleteBody
		f.mu.Unlock()
		if body == "" {
			body = `{"success":true,"existed":true}`
		}
		if failAt > 0 && count == failAt {
			return jsonResponse(200, `{"success":false,"error":"preview failure"}`), nil
		}
		return jsonResponse(200, body), nil
	}
	return nil, fmt.Errorf("unexpected imgbed request %s %s", r.Method, r.URL)
}

func multipartFilename(r *http.Request) string {
	reader, err := r.MultipartReader()
	if err != nil {
		return "unknown.png"
	}
	part, err := reader.NextPart()
	if err != nil {
		return "unknown.png"
	}
	return part.FileName()
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Header:        http.Header{"Content-Type": {"application/json"}},
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
	}
}

func binaryResponse(status int, mime string, body []byte) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Header:        http.Header{"Content-Type": {mime}},
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
	}
}

func newImgbedStore(t *testing.T, fake *fakeImgbed, faults *localFaults) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	var db *sql.DB
	if faults != nil {
		db = sql.OpenDB(localConnector{dsn: "file:" + filepath.Join(dir, "test.db") + "?_pragma=busy_timeout(5000)", faults: faults})
		t.Cleanup(func() { _ = db.Close() })
	} else {
		db = testutil.OpenDB(t)
	}
	s, err := New(db, NewOptions{
		Now:     imgbedNow,
		DataDir: dataDir,
		Imgbed: imgbed.Options{HTTP: safehttp.Options{
			Resolver:  publicResolver{},
			Transport: fake,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InitializeStorage(ctx, domain.StorageInit{
		Mode:          domain.StorageImgbed,
		ImgbedBaseURL: ptr("https://old.example.com"),
		ImgbedToken:   ptr("old-token"),
	}); err != nil {
		t.Fatal(err)
	}
	return s, dataDir
}

func ptr[T any](v T) *T { return &v }

func pngInsert(t *testing.T, key string) domain.GalleryInsert {
	mime := "image/png"
	return domain.GalleryInsert{OutputKey: key, Image: testutil.PNG(t, 2, 2), ImageMIME: &mime}
}

func TestImgbedGalleryPublishReadAndNoLocalOriginal(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2)}
	s, dataDir := newImgbedStore(t, fake, nil)
	ctx := context.Background()

	saved, verified, err := s.SaveDeliveryImage(ctx, pngInsert(t, "imgbed:0:0"), true)
	if err != nil || !bytes.Equal(verified, fake.data) {
		t.Fatalf("save: %+v %v", saved, err)
	}
	if !imgbed.ValidRef(saved.Ref) || saved.Bytes != int64(len(fake.data)) {
		t.Fatalf("ref = %q bytes=%d", saved.Ref, saved.Bytes)
	}
	walked := 0
	_ = filepath.WalkDir(filepath.Join(dataDir, "images"), func(_ string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			walked++
		}
		return nil
	})
	if walked != 0 {
		t.Fatalf("imgbed mode wrote %d local original files", walked)
	}
	if fake.uploads != 1 {
		t.Fatalf("uploads = %d", fake.uploads)
	}
	if fake.readAuth[0] != "" {
		t.Fatal("read-back carried the API token")
	}

	data, mime, err := s.PublicImageContent(ctx, saved.PublicID)
	if err != nil || mime != "image/png" || !bytes.Equal(data, fake.data) {
		t.Fatalf("content: %q %v", mime, err)
	}
	info, err := s.PublicImageInfo(ctx, saved.PublicID)
	if err != nil || info != saved {
		t.Fatalf("info: %+v %v", info, err)
	}
	if fake.heads == 0 {
		t.Fatal("HEAD did not use the remote verify path")
	}
	if _, _, err := s.GalleryContent(ctx, saved.ID, false); err != nil {
		t.Fatalf("admin content: %v", err)
	}
}

func TestImgbedDuplicateReturnsAuthoritativeOriginal(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2)}
	s, _ := newImgbedStore(t, fake, nil)
	ctx := context.Background()

	first, firstBytes, err := s.SaveDeliveryImage(ctx, pngInsert(t, "dup:0:0"), true)
	if err != nil {
		t.Fatal(err)
	}
	mime := "image/png"
	second, data, err := s.SaveDeliveryImage(ctx, domain.GalleryInsert{OutputKey: "dup:0:0", Image: testutil.PNG(t, 3, 3), ImageMIME: &mime}, true)
	if err != nil {
		t.Fatal(err)
	}
	if second != first || !bytes.Equal(data, firstBytes) || !bytes.Equal(data, fake.data) {
		t.Fatalf("duplicate returned a different original: %+v %+v", first, second)
	}
	if fake.uploads != 1 {
		t.Fatalf("duplicate uploaded another candidate: %d", fake.uploads)
	}
}

func TestImgbedUncertainPublicationRetainsCandidate(t *testing.T) {
	faults := &localFaults{}
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2)}
	s, _ := newImgbedStore(t, fake, faults)
	faults.afterQuery = func(q string) error {
		if strings.Contains(q, "INSERT INTO gallery") {
			return errors.New("commit outcome unknown")
		}
		return nil
	}
	if _, err := s.SaveGeneratedImage(context.Background(), pngInsert(t, "uncertain:0:0")); err == nil {
		t.Fatal("ambiguous publish reported success")
	}
	if fake.uploads != 1 {
		t.Fatalf("uploads = %d", fake.uploads)
	}
	if fake.deletes != 0 {
		t.Fatal("candidate was deleted despite an uncertain commit")
	}
}

func TestOriginalNetworkNotBoundByDBTimeout(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2), delay: 80 * time.Millisecond}
	s, _ := newImgbedStore(t, fake, nil)
	s.timeout = 20 * time.Millisecond
	if _, err := s.SaveGeneratedImage(context.Background(), pngInsert(t, "budget:0:0")); err != nil {
		t.Fatalf("network work was bound by the DB timeout: %v", err)
	}
}

func TestStorageUpdateWaitsForUploadSnapshot(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2), readBlock: make(chan struct{})}
	s, _ := newImgbedStore(t, fake, nil)
	ctx := context.Background()

	saveDone := make(chan error, 1)
	go func() {
		_, err := s.SaveGeneratedImage(ctx, pngInsert(t, "snapshot:0:0"))
		saveDone <- err
	}()
	waitFor(t, func() bool {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return fake.reads == 1
	})

	newToken := "new-token"
	updateDone := make(chan error, 1)
	go func() {
		_, err := s.UpdateImgbedStorage(ctx, domain.StorageUpdate{ImgbedBaseURL: "https://new.example.com", ImgbedToken: &newToken})
		updateDone <- err
	}()
	select {
	case err := <-updateDone:
		t.Fatalf("update completed while a snapshot was in flight: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(fake.readBlock)
	if err := <-saveDone; err != nil {
		t.Fatalf("in-flight save: %v", err)
	}
	if err := <-updateDone; err != nil {
		t.Fatalf("update: %v", err)
	}

	fake.mu.Lock()
	fake.readBlock = nil
	fake.mu.Unlock()
	if _, err := s.SaveGeneratedImage(ctx, pngInsert(t, "snapshot:1:0")); err != nil {
		t.Fatalf("post-update save: %v", err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.uploadHost) != 2 || fake.uploadHost[0] != "old.example.com" || fake.uploadHost[1] != "new.example.com" {
		t.Fatalf("upload hosts = %v", fake.uploadHost)
	}
	if fake.uploadAuth[0] != "Bearer old-token" || fake.uploadAuth[1] != "Bearer new-token" {
		t.Fatalf("upload auth = %v", fake.uploadAuth)
	}
}

func TestStorageUpdateCancellationDoesNotApply(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2), readBlock: make(chan struct{})}
	s, _ := newImgbedStore(t, fake, nil)
	ctx := context.Background()

	saveDone := make(chan error, 1)
	go func() {
		_, err := s.SaveGeneratedImage(ctx, pngInsert(t, "cancel:0:0"))
		saveDone <- err
	}()
	waitFor(t, func() bool {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return fake.reads == 1
	})

	updateCtx, cancel := context.WithCancel(ctx)
	updateDone := make(chan error, 1)
	newToken := "new-token"
	go func() {
		_, err := s.UpdateImgbedStorage(updateCtx, domain.StorageUpdate{ImgbedBaseURL: "https://new.example.com", ImgbedToken: &newToken})
		updateDone <- err
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-updateDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled update = %v", err)
	}
	config, found, err := s.ReadStorageConfig(ctx)
	if err != nil || !found || config.ImgbedBaseURL != "https://old.example.com" || config.ImgbedToken != "old-token" {
		t.Fatalf("canceled update changed config: %+v found=%v err=%v", config, found, err)
	}
	close(fake.readBlock)
	if err := <-saveDone; err != nil {
		t.Fatalf("save: %v", err)
	}
}

func TestLocalModeAndUninitializedDoNotTouchImgbed(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2)}
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	s, err := New(testutil.OpenDB(t), NewOptions{
		Now:     imgbedNow,
		DataDir: dataDir,
		Imgbed:  imgbed.Options{HTTP: safehttp.Options{Resolver: publicResolver{}, Transport: fake}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	saveErr := func() error {
		_, err := s.SaveGeneratedImage(ctx, pngInsert(t, "uninit:0:0"))
		return err
	}()
	if status, code := imgbedAPICode(t, saveErr); status != 503 || code != "initialization_required" {
		t.Fatalf("uninitialized save = %d %q", status, code)
	}
	if fake.uploads != 0 || fake.reads != 0 {
		t.Fatal("uninitialized save contacted ImgBed")
	}
	if _, err := s.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveGeneratedImage(ctx, pngInsert(t, "local:0:0")); err != nil {
		t.Fatal(err)
	}
	if fake.uploads != 0 || fake.reads != 0 {
		t.Fatal("local mode contacted ImgBed")
	}
}
