package httpapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
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

type publicImageSpy struct {
	info, body int
	stored     domain.StoredImage
	data       []byte
}

func (s *publicImageSpy) PublicImageInfo(context.Context, string) (domain.StoredImage, error) {
	s.info++
	return s.stored, nil
}
func (s *publicImageSpy) PublicImageContent(context.Context, string) ([]byte, string, error) {
	s.body++
	return s.data, s.stored.MIME, nil
}
func TestSignedImageGETAndHEAD(t *testing.T) {
	for _, tc := range []struct {
		mime, extension string
		data            []byte
	}{
		{"image/png", ".png", testutil.PNG(t, 4, 4)},
		{"image/jpeg", ".jpg", testutil.JPEG(t, 4, 4)},
		{"image/webp", ".webp", testutil.WebP(4, 4)},
	} {
		t.Run(tc.mime, func(t *testing.T) {
			now := time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)
			signer := auth.NewImageLinks("secret", func() time.Time { return now })
			spy := &publicImageSpy{stored: domain.StoredImage{ID: 1, PublicID: "0123456789abcdef0123456789abcdef", MIME: tc.mime, Bytes: int64(len(tc.data))}, data: tc.data}
			handler := httpapi.New(httpapi.Options{ImageLinks: signer, PublicImages: spy})
			link, _ := signer.Issue("https://images.example", spy.stored.PublicID, time.Hour)
			for _, method := range []string{"GET", "HEAD"} {
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, httptest.NewRequest(method, link, nil))
				if rec.Code != 200 || rec.Header().Get("Content-Type") != tc.mime || rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Content-Length") != strconv.Itoa(len(tc.data)) || !strings.Contains(rec.Header().Get("Content-Disposition"), tc.extension) {
					t.Fatalf("%s: %d %v", method, rec.Code, rec.Header())
				}
				if method == "GET" && !bytes.Equal(rec.Body.Bytes(), spy.data) {
					t.Fatal("original differs")
				}
				if method == "HEAD" && rec.Body.Len() != 0 {
					t.Fatal("HEAD has body")
				}
			}
			if spy.info != 1 || spy.body != 1 {
				t.Fatalf("HEAD loaded original: info=%d body=%d", spy.info, spy.body)
			}
		})
	}
}
func TestSignedImageRejectsBeforeStore(t *testing.T) {
	now := time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)
	signer := auth.NewImageLinks("secret", func() time.Time { return now })
	spy := &publicImageSpy{}
	handler := httpapi.New(httpapi.Options{ImageLinks: signer, PublicImages: spy})
	link, _ := signer.Issue("https://images.example", "0123456789abcdef0123456789abcdef", time.Hour)
	parsed, _ := url.Parse(link)
	for _, suffix := range []string{"&signature=duplicate", "&expires=1", "&unknown=x"} {
		req := httptest.NewRequest("GET", link+suffix, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != 404 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(rec.Code, rec.Body.String())
		}
	}
	parsed.Path = "/v1/images/content/1123456789abcdef0123456789abcdef"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", parsed.String(), nil))
	if rec.Code != 404 {
		t.Fatal("tampering accepted")
	}
	now = now.Add(time.Hour)
	for _, method := range []string{"GET", "HEAD"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(method, link, nil))
		if rec.Code != 404 || method == "HEAD" && rec.Body.Len() != 0 {
			t.Fatal(rec.Code, rec.Body.String())
		}
	}
	if spy.info != 0 || spy.body != 0 {
		t.Fatal("invalid signature read database")
	}
}

type contentDownload []byte

func (d contentDownload) Download(context.Context, string) ([]byte, string, error) {
	return []byte(d), "image/png", nil
}
func TestHTTPDeliveryURLBase64Equality(t *testing.T) {
	s, constructErr := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	requireLocalStorage(t, s)
	data := testutil.PNG(t, 4, 4)
	tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 8})
	defer tasks.Drain(ctx)
	im := service.NewImages(service.ImageOptions{Tasks: tasks, Delivery: service.NewDelivery(service.DeliveryOptions{Store: s, Downloader: contentDownload(data)}), Subrequest: func(context.Context, int64) (agnes.Generation, error) {
		source := "https://agnes.example/original.png"
		return agnes.Generation{Images: []domain.OutputImage{{URL: &source}}}, nil
	}})
	guard := httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret"})
	signer := auth.NewImageLinks("secret", nil)
	handler := httpapi.New(httpapi.Options{Auth: guard, Images: im, Storage: initializedStorage{}, ImageLinks: signer, PublicImages: s, Settings: s.ReadSettings})
	for _, format := range []string{"url", "b64_json"} {
		request := httptest.NewRequest("POST", "https://proxy.example/v1/images/generations", strings.NewReader(`{"model":"m","prompt":"p","response_format":"`+format+`"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer secret")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, request)
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var response struct {
			Data []map[string]json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if len(response.Data) != 1 {
			t.Fatal("missing image")
		}
		item := response.Data[0]
		if _, ok := item[format]; !ok {
			t.Fatal("selected field missing", item)
		}
		other := "url"
		if format == "url" {
			other = "b64_json"
		}
		if _, ok := item[other]; ok {
			t.Fatal("extra format", item)
		}
		if format == "url" {
			var link string
			_ = json.Unmarshal(item["url"], &link)
			if !strings.HasPrefix(link, "https://proxy.example/v1/images/content/") {
				t.Fatal("Agnes URL exposed", link)
			}
			get := httptest.NewRecorder()
			handler.ServeHTTP(get, httptest.NewRequest("GET", link, nil))
			if get.Code != 200 || !bytes.Equal(get.Body.Bytes(), data) {
				t.Fatal("signed GET differs", get.Code)
			}
		} else {
			var encoded string
			_ = json.Unmarshal(item["b64_json"], &encoded)
			decoded, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil || !bytes.Equal(decoded, data) {
				t.Fatal("base64 differs", err)
			}
		}
		page, err := s.ListGallery(ctx, domain.CursorQuery{})
		if err != nil || len(page.Items) == 0 {
			t.Fatal("response before persistence", err)
		}
	}
}
