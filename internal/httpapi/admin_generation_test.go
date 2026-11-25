package httpapi_test

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

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func adminGenerationEnv(t *testing.T, available bool) (*adminEnv, string, []byte) {
	t.Helper()
	ctx := context.Background()
	st, err := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	requireLocalStorage(t, st)
	sessions := auth.NewSessions("secret-key", st, time.Now)
	token, err := sessions.Issue(ctx)
	if err != nil {
		t.Fatal(err)
	}
	data := testutil.PNG(t, 4, 4)
	var im *service.Images
	if available {
		tasks := service.NewTasks(service.TaskOptions{Workers: 1, Capacity: 4})
		t.Cleanup(func() { _ = tasks.Drain(context.Background()) })
		im = service.NewImages(service.ImageOptions{Tasks: tasks, Logs: st,
			Delivery: service.NewDelivery(service.DeliveryOptions{Store: st, Downloader: contentDownload(data)}),
			Subrequest: func(context.Context, int64) (agnes.Generation, error) {
				source := "https://agnes.example/output.png"
				return agnes.Generation{Images: []domain.OutputImage{{URL: &source}}}, nil
			},
		})
	}
	handler := httpapi.New(httpapi.Options{
		Auth:  httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret-key", Sessions: sessions}),
		Store: st, Storage: st, Settings: st.ReadSettings, Logs: st, PublicImages: st,
		ImageLinks: auth.NewImageLinks("secret-key", nil), Images: im,
	})
	return &adminEnv{handler: handler, store: st}, token, data
}

func generationReq(method, path, body, token, origin, bearer string) *http.Request {
	req := httptest.NewRequest(method, "https://proxy.example"+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.AddCookie(&http.Cookie{Name: httpapi.SessionCookieName, Value: token})
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return req
}

func TestAdminGenerationAuthentication(t *testing.T) {
	env, token, _ := adminGenerationEnv(t, true)
	for _, tc := range []struct {
		name, token, origin, bearer, path string
		want                              int
	}{
		{"cookie", token, "https://proxy.example", "", "/admin/api/images/generations", 200},
		{"bearer", "", "", "secret-key", "/admin/api/images/generations", 200},
		{"anonymous", "", "", "", "/admin/api/images/generations", 401},
		{"invalid bearer cannot fall back", token, "https://proxy.example", "wrong", "/admin/api/images/generations", 401},
		{"cross origin", token, "https://evil.example", "", "/admin/api/images/generations", 403},
		{"missing origin", token, "", "", "/admin/api/images/generations", 403},
		{"public still bearer only", token, "https://proxy.example", "", "/v1/images/generations", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := callHandler(env.handler, generationReq("POST", tc.path, `{"model":"m","prompt":"p"}`, tc.token, tc.origin, tc.bearer))
			if rec.Code != tc.want {
				t.Fatalf("status=%d want=%d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

func TestAdminGenerationDeliveryAndLogs(t *testing.T) {
	env, token, original := adminGenerationEnv(t, true)
	for _, format := range []string{"url", "b64_json"} {
		rec := callHandler(env.handler, generationReq("POST", "/admin/api/images/generations", `{"model":"m","prompt":"forest","n":2,"response_format":"`+format+`"}`, token, "https://proxy.example", ""))
		if rec.Code != 200 {
			t.Fatalf("generation=%d %s", rec.Code, rec.Body.String())
		}
		var response httpapi.ImageResponse
		decodeBody(t, rec, &response)
		if len(response.Data) != 2 {
			t.Fatalf("images=%d", len(response.Data))
		}
		for _, item := range response.Data {
			if format == "url" {
				if item.URL == nil {
					t.Fatal("missing URL")
				}
				image := callHandler(env.handler, httptest.NewRequest("GET", *item.URL, nil))
				if image.Code != 200 || !bytes.Equal(image.Body.Bytes(), original) {
					t.Fatalf("original=%d", image.Code)
				}
			} else {
				if item.B64JSON == nil {
					t.Fatal("missing Base64")
				}
				decoded, err := base64.StdEncoding.DecodeString(*item.B64JSON)
				if err != nil || !bytes.Equal(decoded, original) {
					t.Fatal("wrong original", err)
				}
			}
		}
	}
	gallery, err := env.store.ListGallery(context.Background(), domain.CursorQuery{})
	if err != nil || len(gallery.Items) != 4 {
		t.Fatalf("gallery=%+v %v", gallery, err)
	}
	logs, err := env.store.ListLogs(context.Background(), domain.CursorQuery{})
	if err != nil || len(logs.Items) != 2 {
		t.Fatalf("logs=%+v %v", logs, err)
	}
	for _, item := range gallery.Items {
		matched := false
		for _, log := range logs.Items {
			if log.RequestID == item.RequestID && log.OK {
				matched = true
			}
		}
		if !matched {
			t.Fatal("gallery lacks request log", item.RequestID)
		}
	}
}

func TestAdminGenerationMethodsAndAvailability(t *testing.T) {
	env, _, _ := adminGenerationEnv(t, false)
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{"POST", "/admin/api/images/generations", 503},
		{"GET", "/admin/api/images/generations", 405},
		{"PUT", "/admin/api/images/generations", 405},
		{"POST", "/admin/api/images/generations/extra", 404},
		{"POST", "/admin/api/images/edits", 404},
	} {
		rec := callHandler(env.handler, generationReq(tc.method, tc.path, `{}`, "", "", "secret-key"))
		if rec.Code != tc.want {
			t.Fatalf("%s %s=%d want=%d", tc.method, tc.path, rec.Code, tc.want)
		}
		if tc.want == 405 && rec.Header().Get("Allow") != "POST" {
			t.Fatal("wrong Allow")
		}
	}
}

func TestAdminGenerationBodyValidation(t *testing.T) {
	env, _, _ := adminGenerationEnv(t, true)
	padded := append(testutil.PNG(t, 4, 4), make([]byte, 1<<20)...)
	reference := "data:image/png;base64," + base64.StdEncoding.EncodeToString(padded)
	large, _ := json.Marshal(map[string]any{"model": "m", "prompt": "p", "images": []string{reference}})
	rec := callHandler(env.handler, generationReq("POST", "/admin/api/images/generations", string(large), "", "", "secret-key"))
	if rec.Code != 200 {
		t.Fatalf("valid >1MiB reference=%d %s", rec.Code, rec.Body.String())
	}
	for _, body := range []string{`{"model":"m","prompt":"p","n":0}`, `{"model":"m","prompt":"p","n":1.5}`, `{"model":"m","prompt":"p","mask":true}`, strings.Repeat(" ", (32<<20)+1)} {
		rec := callHandler(env.handler, generationReq("POST", "/admin/api/images/generations", body, "", "", "secret-key"))
		if rec.Code != 400 && rec.Code != 413 {
			t.Fatalf("invalid body=%d %s", rec.Code, rec.Body.String())
		}
	}
	logs, err := env.store.ListLogs(context.Background(), domain.CursorQuery{})
	if err != nil {
		t.Fatal(err)
	}
	failures := 0
	for _, log := range logs.Items {
		if log.Stage == "parse" && !log.OK {
			failures++
		}
	}
	if failures != 4 {
		t.Fatalf("parse logs=%d", failures)
	}
}
