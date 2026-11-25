package httpapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/imgbed"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/safehttp"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

type imgbedResolver struct{}

func (imgbedResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
}

type lifecycleImgbed struct {
	mu      sync.Mutex
	data    []byte
	uploads int
	deletes int
}

func (f *lifecycleImgbed) RoundTrip(r *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/upload":
		f.uploads++
		reader, err := r.MultipartReader()
		if err != nil {
			return nil, err
		}
		part, err := reader.NextPart()
		if err != nil {
			return nil, err
		}
		src := r.URL.Scheme + "://" + r.URL.Host + "/file/" +
			r.URL.Query().Get("uploadFolder") + "/" + part.FileName()
		body := `[{"src":"` + src + `"}]`
		return &http.Response{
			StatusCode:    200,
			Header:        http.Header{"Content-Type": {"application/json"}},
			Body:          io.NopCloser(strings.NewReader(body)),
			ContentLength: int64(len(body)),
			Request:       r,
		}, nil
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/file/"):
		return &http.Response{
			StatusCode:    200,
			Header:        http.Header{"Content-Type": {"image/png"}},
			Body:          io.NopCloser(bytes.NewReader(f.data)),
			ContentLength: int64(len(f.data)),
			Request:       r,
		}, nil
	case r.Method == http.MethodHead && strings.HasPrefix(r.URL.Path, "/file/"):
		return &http.Response{
			StatusCode:    200,
			Header:        http.Header{"Content-Type": {"image/png"}},
			Body:          io.NopCloser(strings.NewReader("")),
			ContentLength: int64(len(f.data)),
			Request:       r,
		}, nil
	case strings.HasPrefix(r.URL.Path, "/api/manage/delete/"):
		f.deletes++
		body := `{"success":true,"existed":true}`
		return &http.Response{
			StatusCode:    200,
			Header:        http.Header{"Content-Type": {"application/json"}},
			Body:          io.NopCloser(strings.NewReader(body)),
			ContentLength: int64(len(body)),
			Request:       r,
		}, nil
	}
	return nil, nil
}

type lifecycleDownload struct{ data []byte }

func (d lifecycleDownload) Download(context.Context, string) ([]byte, string, error) {
	return d.data, "image/png", nil
}

func TestImgbedSignedLifecycle(t *testing.T) {
	data := testutil.PNG(t, 4, 4)
	fake := &lifecycleImgbed{data: data}
	dataDir := t.TempDir()
	st, err := store.New(testutil.OpenDB(t), store.NewOptions{
		DataDir: dataDir,
		Imgbed: imgbed.Options{HTTP: safehttp.Options{
			Resolver:  imgbedResolver{},
			Transport: fake,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	if err := st.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	url, token := "https://img.example.com", "token"
	if _, err := st.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageImgbed, ImgbedBaseURL: &url, ImgbedToken: &token}); err != nil {
		t.Fatal(err)
	}

	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 8})
	defer tasks.Drain(ctx)
	images := service.NewImages(service.ImageOptions{
		Tasks:    tasks,
		Delivery: service.NewDelivery(service.DeliveryOptions{Store: st, Downloader: lifecycleDownload{data: data}}),
		Subrequest: func(context.Context, int64) (agnes.Generation, error) {
			source := "https://agnes.example/original.png"
			return agnes.Generation{Images: []domain.OutputImage{{URL: &source}}}, nil
		},
	})
	signer := auth.NewImageLinks("secret", nil)
	guard := httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret"})
	handler := httpapi.New(httpapi.Options{
		Auth:         guard,
		Store:        st,
		Storage:      st,
		Images:       images,
		ImageLinks:   signer,
		PublicImages: st,
		Settings:     st.ReadSettings,
		Logs:         st,
	})

	generate := func(prompt string, extra string) *httptest.ResponseRecorder {
		body := `{"model":"m","prompt":"` + prompt + `"` + extra + `}`
		request := httptest.NewRequest(http.MethodPost, "https://proxy.example/v1/images/generations", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer secret")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, request)
		return rec
	}
	adminGet := func(path string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "https://proxy.example"+path, nil)
		request.Header.Set("Authorization", "Bearer secret")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, request)
		return rec
	}
	adminDelete := func(path string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodDelete, "https://proxy.example"+path, nil)
		request.Header.Set("Authorization", "Bearer secret")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, request)
		return rec
	}

	rec := generate("signed lifecycle", "")
	if rec.Code != 200 {
		t.Fatalf("generation = %d %s", rec.Code, rec.Body.String())
	}
	var response struct {
		Data []struct {
			URL *string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil || len(response.Data) != 1 || response.Data[0].URL == nil {
		t.Fatalf("response = %s (%v)", rec.Body.String(), err)
	}
	link := *response.Data[0].URL
	if !strings.HasPrefix(link, "https://proxy.example/v1/images/content/") || strings.Contains(link, "img.example.com") {
		t.Fatalf("signed URL = %q", link)
	}

	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, link, nil))
	if get.Code != 200 || !bytes.Equal(get.Body.Bytes(), data) {
		t.Fatalf("signed GET = %d", get.Code)
	}
	head := httptest.NewRecorder()
	handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, link, nil))
	if head.Code != 200 || head.Body.Len() != 0 {
		t.Fatalf("signed HEAD = %d body=%d", head.Code, head.Body.Len())
	}

	rec = generate("signed lifecycle", `,"response_format":"b64_json"`)
	if rec.Code != 200 {
		t.Fatalf("b64 generation = %d %s", rec.Code, rec.Body.String())
	}
	var b64Response struct {
		Data []struct {
			B64 *string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &b64Response); err != nil || len(b64Response.Data) != 1 || b64Response.Data[0].B64 == nil {
		t.Fatalf("b64 response = %s", rec.Body.String())
	}
	decoded, err := base64.StdEncoding.DecodeString(*b64Response.Data[0].B64)
	if err != nil || !bytes.Equal(decoded, data) {
		t.Fatalf("b64 original differs: %v", err)
	}

	walked := 0
	_ = filepath.WalkDir(filepath.Join(dataDir, "images"), func(_ string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			walked++
		}
		return nil
	})
	if walked != 0 {
		t.Fatalf("imgbed lifecycle wrote %d local originals", walked)
	}

	list := adminGet("/admin/api/gallery?limit=10")
	if list.Code != 200 {
		t.Fatalf("gallery list = %d %s", list.Code, list.Body.String())
	}
	var page struct {
		Items []struct {
			ID int64 `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil || len(page.Items) == 0 {
		t.Fatalf("gallery list = %s", list.Body.String())
	}
	adminContent := adminGet("/admin/api/gallery/" + itoa64(page.Items[0].ID) + "/content")
	if adminContent.Code != 200 || !bytes.Equal(adminContent.Body.Bytes(), data) {
		t.Fatalf("admin content = %d", adminContent.Code)
	}

	// A signed URL is accepted as a reference and read through the storage
	// backend, never by an HTTP self-request.
	rec = generate("reference reuse", `,"size":"auto","images":["`+link+`"]`)
	if rec.Code != 200 {
		t.Fatalf("reference generation = %d %s", rec.Code, rec.Body.String())
	}

	if fake.deletes != 0 {
		t.Fatal("unexpected delete before admin action")
	}
	// Listings are newest-first; the signed link belongs to the oldest row.
	linkID := page.Items[len(page.Items)-1].ID
	if del := adminDelete("/admin/api/gallery/" + itoa64(linkID)); del.Code != 204 {
		t.Fatalf("delete = %d %s", del.Code, del.Body.String())
	}
	if fake.deletes == 0 {
		t.Fatal("admin delete did not remove the remote original")
	}
	gone := httptest.NewRecorder()
	handler.ServeHTTP(gone, httptest.NewRequest(http.MethodGet, link, nil))
	if gone.Code != 404 {
		t.Fatalf("deleted signed URL = %d", gone.Code)
	}
	if fake.uploads != 3 {
		t.Fatalf("uploads = %d", fake.uploads)
	}
}
