package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func newStorageEnv(t *testing.T) (*store.Store, http.Handler) {
	t.Helper()
	st, _ := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	t.Cleanup(func() { _ = st.Close() })
	if err := st.EnsureSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessions("secret-key", st, time.Now)
	authn := httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret-key", Sessions: sessions, Limiter: auth.NewLimiter(time.Now)})
	handler := httpapi.New(httpapi.Options{
		Auth:     authn,
		Store:    st,
		Storage:  st,
		Settings: st.ReadSettings,
		Logs:     st,
	})
	return st, handler
}

func adminJSON(t *testing.T, rec *httptest.ResponseRecorder) (int, string, map[string]any) {
	t.Helper()
	var envelope struct {
		Error struct {
			Code *string `json:"code"`
		} `json:"error"`
	}
	code := ""
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err == nil && envelope.Error.Code != nil {
		code = *envelope.Error.Code
	}
	var object map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &object)
	return rec.Code, code, object
}

func TestStorageHTTPStatesAndSecrets(t *testing.T) {
	_, handler := newStorageEnv(t)

	rec := callHandler(handler, adminReq(http.MethodGet, "/admin/api/storage", ""))
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"initialized":false}` {
		t.Fatalf("fresh GET = %d %s", rec.Code, rec.Body.String())
	}

	rec = callHandler(handler, adminReq(http.MethodPost, "/admin/api/storage", `{"mode":"local"}`))
	if rec.Code != 201 || strings.TrimSpace(rec.Body.String()) != `{"initialized":true,"mode":"local"}` {
		t.Fatalf("local init = %d %s", rec.Code, rec.Body.String())
	}
	rec = callHandler(handler, adminReq(http.MethodPost, "/admin/api/storage", `{"mode":"imgbed","imgbedBaseUrl":"https://img.example.com","imgbedToken":"x"}`))
	if status, code, _ := adminJSON(t, rec); status != 409 || code != "already_initialized" {
		t.Fatalf("second init = %d %q", status, code)
	}

	imgbedStore, imgbedHandler := newStorageEnv(t)
	rec = callHandler(imgbedHandler, adminReq(http.MethodPost, "/admin/api/storage",
		`{"mode":"imgbed","imgbedBaseUrl":"https://IMG.Example.com:443/","imgbedToken":"  secret-token  "}`))
	if rec.Code != 201 {
		t.Fatalf("imgbed init = %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "secret-token") || !strings.Contains(body, `"imgbedBaseUrl":"https://img.example.com"`) || !strings.Contains(body, `"hasImgbedToken":true`) {
		t.Fatalf("imgbed init body = %s", body)
	}

	rec = callHandler(imgbedHandler, adminReq(http.MethodPut, "/admin/api/storage",
		`{"imgbedBaseUrl":"https://new.example.com","imgbedToken":""}`))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "secret-token") {
		t.Fatalf("retain token PUT = %d %s", rec.Code, rec.Body.String())
	}
	config, _, err := imgbedStore.ReadStorageConfig(context.Background())
	if err != nil || config.ImgbedBaseURL != "https://new.example.com" || config.ImgbedToken != "secret-token" {
		t.Fatalf("retained config = %+v %v", config, err)
	}

	rec = callHandler(imgbedHandler, adminReq(http.MethodPut, "/admin/api/storage",
		`{"imgbedBaseUrl":"https://img.example.com","imgbedToken":"new-token"}`))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "new-token") {
		t.Fatalf("replace token PUT = %d %s", rec.Code, rec.Body.String())
	}
	config, _, err = imgbedStore.ReadStorageConfig(context.Background())
	if err != nil || config.ImgbedToken != "new-token" {
		t.Fatalf("replaced config = %+v %v", config, err)
	}

	for name, body := range map[string]string{
		"mode on update":  `{"mode":"local","imgbedBaseUrl":"https://img.example.com"}`,
		"null token":      `{"imgbedBaseUrl":"https://img.example.com","imgbedToken":null}`,
		"unknown field":   `{"imgbedBaseUrl":"https://img.example.com","other":"x"}`,
		"missing address": `{"imgbedToken":"x"}`,
	} {
		rec = callHandler(imgbedHandler, adminReq(http.MethodPut, "/admin/api/storage", body))
		if rec.Code != 400 {
			t.Fatalf("%s = %d %s", name, rec.Code, rec.Body.String())
		}
	}

	localStore, localHandler := newStorageEnv(t)
	if _, err := localStore.InitializeStorage(context.Background(), domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		t.Fatal(err)
	}
	rec = callHandler(localHandler, adminReq(http.MethodPut, "/admin/api/storage", `{"imgbedBaseUrl":"https://img.example.com"}`))
	if status, code, _ := adminJSON(t, rec); status != 409 || code != "storage_mode_fixed" {
		t.Fatalf("local PUT = %d %q", status, code)
	}

	_, uninitHandler := newStorageEnv(t)
	rec = callHandler(uninitHandler, adminReq(http.MethodPut, "/admin/api/storage", `{"imgbedBaseUrl":"https://img.example.com"}`))
	if status, code, _ := adminJSON(t, rec); status != 409 || code != "not_initialized" {
		t.Fatalf("uninitialized PUT = %d %q", status, code)
	}

	for name, body := range map[string]string{
		"unknown mode":       `{"mode":"s3"}`,
		"local with null":    `{"mode":"local","imgbedBaseUrl":null}`,
		"local with empty":   `{"mode":"local","imgbedToken":""}`,
		"imgbed missing":     `{"mode":"imgbed"}`,
		"null mode":          `{"mode":null}`,
		"unknown init field": `{"mode":"local","other":true}`,
	} {
		_, fresh := newStorageEnv(t)
		rec := callHandler(fresh, adminReq(http.MethodPost, "/admin/api/storage", body))
		if rec.Code != 400 {
			t.Fatalf("%s = %d %s", name, rec.Code, rec.Body.String())
		}
	}

	t.Run("state precedes payload validation", func(t *testing.T) {
		_, initialized := newStorageEnv(t)
		if rec := callHandler(initialized, adminReq(http.MethodPost, "/admin/api/storage", `{"mode":"local"}`)); rec.Code != 201 {
			t.Fatalf("local init = %d %s", rec.Code, rec.Body.String())
		}
		for name, body := range map[string]string{
			"unknown mode":       `{"mode":"s3"}`,
			"imgbed missing":     `{"mode":"imgbed"}`,
			"local with empty":   `{"mode":"local","imgbedToken":""}`,
			"unknown init field": `{"mode":"local","other":true}`,
		} {
			rec := callHandler(initialized, adminReq(http.MethodPost, "/admin/api/storage", body))
			if status, code, _ := adminJSON(t, rec); status != 409 || code != "already_initialized" {
				t.Fatalf("%s after init = %d %q", name, status, code)
			}
		}
		rec := callHandler(initialized, adminReq(http.MethodPut, "/admin/api/storage", `{"imgbedBaseUrl":"not a url"}`))
		if status, code, _ := adminJSON(t, rec); status != 409 || code != "storage_mode_fixed" {
			t.Fatalf("local invalid PUT = %d %q", status, code)
		}

		_, uninit := newStorageEnv(t)
		rec = callHandler(uninit, adminReq(http.MethodPut, "/admin/api/storage", `{"imgbedBaseUrl":"not a url"}`))
		if status, code, _ := adminJSON(t, rec); status != 409 || code != "not_initialized" {
			t.Fatalf("uninitialized invalid PUT = %d %q", status, code)
		}
	})

	t.Run("concurrent initialization", func(t *testing.T) {
		_, concurrent := newStorageEnv(t)
		var wg sync.WaitGroup
		results := make(chan int, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				rec := callHandler(concurrent, adminReq(http.MethodPost, "/admin/api/storage", `{"mode":"local"}`))
				results <- rec.Code
			}()
		}
		wg.Wait()
		close(results)
		created, conflicts := 0, 0
		for status := range results {
			switch status {
			case 201:
				created++
			case 409:
				conflicts++
			default:
				t.Fatalf("unexpected status %d", status)
			}
		}
		if created != 1 || conflicts != 1 {
			t.Fatalf("created=%d conflicts=%d", created, conflicts)
		}
		rec := callHandler(concurrent, adminReq(http.MethodGet, "/admin/api/storage", ""))
		if strings.TrimSpace(rec.Body.String()) != `{"initialized":true,"mode":"local"}` {
			t.Fatalf("status after race = %s", rec.Body.String())
		}
	})
}

func TestStorageAuthAndOrigin(t *testing.T) {
	_, handler := newStorageEnv(t)

	rec := callHandler(handler, httptest.NewRequest(http.MethodGet, "/admin/api/storage", nil))
	if rec.Code != 401 {
		t.Fatalf("unauthenticated GET = %d", rec.Code)
	}

	rec = callHandler(handler, adminReq(http.MethodGet, "/admin/api/storage", ""))
	if rec.Code != 200 {
		t.Fatalf("bearer GET = %d", rec.Code)
	}

	login := httptest.NewRequest(http.MethodPost, "/admin/api/session", strings.NewReader(`{"apiKey":"secret-key"}`))
	login.Header.Set("Content-Type", "application/json")
	rec = callHandler(handler, login)
	if rec.Code != 200 {
		t.Fatalf("login = %d %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("login did not set a session cookie")
	}

	cookieReq := func(method, body, origin string) *http.Request {
		req := httptest.NewRequest(method, "/admin/api/storage", strings.NewReader(body))
		req.RemoteAddr = "192.0.2.10:1234"
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		for _, cookie := range cookies {
			req.AddCookie(cookie)
		}
		return req
	}
	if rec := callHandler(handler, cookieReq(http.MethodGet, "", "")); rec.Code != 200 {
		t.Fatalf("cookie GET = %d", rec.Code)
	}
	if rec := callHandler(handler, cookieReq(http.MethodPost, `{"mode":"local"}`, "https://evil.example")); rec.Code != 403 {
		t.Fatalf("cross-origin cookie mutation = %d", rec.Code)
	}
	if rec := callHandler(handler, cookieReq(http.MethodPost, `{"mode":"local"}`, "http://example.com")); rec.Code != 201 {
		t.Fatalf("same-site cookie mutation = %d %s", rec.Code, rec.Body.String())
	}
}
