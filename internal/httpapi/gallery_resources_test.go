package httpapi_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func resourcePointer(v string) *string { return &v }

func TestPublicGalleryResources(t *testing.T) {
	env := newAdminEnv(t, adminProber{})
	handler := httpapi.New(httpapi.Options{GalleryResources: env.store})
	for _, tc := range []struct{ mime, ext string }{{"image/png", "png"}, {"image/jpeg", "jpg"}, {"image/webp", "webp"}} {
		in := domain.GalleryInsert{OutputKey: "public:" + tc.ext, Image: testutil.PNG(t, 2, 2), ImageMIME: &tc.mime}
		saved, err := env.store.SaveGeneratedImage(context.Background(), in)
		if err != nil {
			t.Fatal(err)
		}
		target := "/images/" + saved.PublicID + "/original." + tc.ext
		for _, method := range []string{"GET", "HEAD"} {
			req := httptest.NewRequest(method, target, nil)
			req.AddCookie(&http.Cookie{Name: httpapi.SessionCookieName, Value: "expired-admin-cookie"})
			rec := callHandler(handler, req)
			if rec.Code != 200 {
				t.Fatalf("%s %s = %d %s", method, target, rec.Code, rec.Body.String())
			}
			if rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || rec.Header().Get("Set-Cookie") != "" {
				t.Fatalf("unsafe cache headers: %v", rec.Header())
			}
			if rec.Header().Get("Content-Type") != tc.mime || rec.Header().Get("Content-Length") != strconv.Itoa(len(in.Image)) || !strings.Contains(rec.Header().Get("Content-Disposition"), "original."+tc.ext) {
				t.Fatalf("image headers: %v", rec.Header())
			}
			if method == "GET" && !bytes.Equal(rec.Body.Bytes(), in.Image) || method == "HEAD" && rec.Body.Len() != 0 {
				t.Fatalf("%s returned incorrect body", method)
			}
		}
	}
}

func TestPublicGalleryResourceIdentity(t *testing.T) {
	env := newAdminEnv(t, adminProber{})
	handler := httpapi.New(httpapi.Options{GalleryResources: env.store})
	saved, err := env.store.SaveGeneratedImage(context.Background(), domain.GalleryInsert{OutputKey: "identity", Image: testutil.PNG(t, 2, 2), ImageMIME: resourcePointer("image/png")})
	if err != nil {
		t.Fatal(err)
	}
	prefix := "/images/" + saved.PublicID + "/"
	for _, target := range []string{
		"/images/1/original.png", "/images/INVALID/original.png", prefix + "original.jpg", prefix + "original.png/extra", prefix + "../original.png", prefix + "%2e%2e/original.png", prefix + "%2foriginal.png", prefix + "thumb-0123456789abcdef0123456789abcdef.png", prefix + "secret.txt",
	} {
		for _, method := range []string{"GET", "HEAD"} {
			rec := callHandler(handler, httptest.NewRequest(method, target, nil))
			if rec.Code != 404 || rec.Header().Get("Cache-Control") != "no-store" || method == "HEAD" && rec.Body.Len() != 0 {
				t.Fatalf("%s %s = %d %v", method, target, rec.Code, rec.Header())
			}
		}
	}
	rec := callHandler(handler, httptest.NewRequest("POST", prefix+"original.png", nil))
	if rec.Code != 405 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("POST = %d", rec.Code)
	}
	if _, err := env.store.DeleteGallery(context.Background(), saved.ID); err != nil {
		t.Fatal(err)
	}
	rec = callHandler(handler, httptest.NewRequest("GET", prefix+"original.png", nil))
	if rec.Code != 404 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("deleted resource = %d", rec.Code)
	}
}

func TestGalleryPublicDoesNotChangeAuth(t *testing.T) {
	env := newAdminEnv(t, adminProber{})
	now := time.Now()
	signer := auth.NewImageLinks("secret-key", func() time.Time { return now })
	guard := httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret-key", Sessions: auth.NewSessions("secret-key", env.store, func() time.Time { return now })})
	handler := httpapi.New(httpapi.Options{Auth: guard, Store: env.store, Storage: env.store, PublicImages: env.store, ImageLinks: signer, GalleryResources: env.store})
	saved, err := env.store.SaveGeneratedImage(context.Background(), domain.GalleryInsert{OutputKey: "auth", Image: testutil.PNG(t, 2, 2), ImageMIME: resourcePointer("image/png")})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path string }{{"GET", "/admin/api/gallery"}, {"DELETE", "/admin/api/gallery"}, {"GET", "/admin/api/gallery/" + strconv.FormatInt(saved.ID, 10) + "/content"}} {
		rec := callHandler(handler, httptest.NewRequest(tc.method, tc.path, nil))
		if rec.Code != 401 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("admin auth changed: %d", rec.Code)
		}
	}
	link, err := signer.Issue("https://proxy.example", saved.PublicID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	rec := callHandler(handler, httptest.NewRequest("GET", link, nil))
	if rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("signed resource = %d", rec.Code)
	}
	now = now.Add(2 * time.Hour)
	rec = callHandler(handler, httptest.NewRequest("GET", link, nil))
	if rec.Code != 404 {
		t.Fatalf("expired signed resource = %d", rec.Code)
	}
}
