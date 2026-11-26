package httpapi_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

func TestGenerationKeyLifecycleAndAdminBoundary(t *testing.T) {
	env := newAdminEnv(t, adminProber{})
	build := func(adminKey string) http.Handler {
		return httpapi.New(httpapi.Options{
			Auth: httpapi.NewAuth(httpapi.AuthOptions{
				APIKey: adminKey, LookupGenerationKey: env.store.LookupGenerationKey,
				Sessions: auth.NewSessions(adminKey, env.store, time.Now), Limiter: auth.NewLimiter(time.Now),
			}),
			Images: service.NewImages(service.ImageOptions{}), Store: env.store,
			Storage: env.store, Settings: env.store.ReadSettings, Logs: env.store,
		})
	}
	const keys = "/admin/api/api-keys"
	const adminKey = "secret-key"
	handler := build(adminKey)
	request := func(method, path, body, bearer string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		return callHandler(handler, req)
	}
	if rec := request("POST", keys, `{"name":" ","role":"admin"}`, adminKey); rec.Code != 400 {
		t.Fatalf("unknown field status = %d", rec.Code)
	}
	if rec := request("POST", keys, `{"name":" "}`, adminKey); rec.Code != 400 {
		t.Fatalf("blank name status = %d", rec.Code)
	}
	created := request("POST", keys, `{"name":"  客户端  "}`, adminKey)
	if created.Code != 201 || created.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("create status = %d", created.Code)
	}
	var summary struct {
		ID      int64
		Name    string
		KeyHint string
	}
	decodeBody(t, created, &summary)
	if summary.ID <= 0 || summary.Name != "客户端" || !strings.HasPrefix(summary.KeyHint, "sk-") {
		t.Fatal("wrong created metadata")
	}
	path := fmt.Sprintf("%s/%d", keys, summary.ID)
	retrieve := func(admin string) string {
		t.Helper()
		rec := request("GET", path, "", admin)
		if rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("copy status = %d", rec.Code)
		}
		var body struct{ APIKey string }
		decodeBody(t, rec, &body)
		return body.APIKey
	}
	key := retrieve(adminKey)
	handler = build(adminKey) // Credentials survive a fresh router with the same configuration.
	if !strings.HasPrefix(key, "sk-agnes-") || retrieve(adminKey) != key {
		t.Fatal("copy didn't return a stable sk- credential")
	}
	listed := request("GET", keys, "", adminKey)
	if listed.Code != 200 || !strings.Contains(listed.Body.String(), "客户端") || strings.Contains(listed.Body.String(), key) || strings.Contains(listed.Body.String(), `"apiKey"`) {
		t.Fatal("incorrect or unredacted list")
	}
	for _, endpoint := range []string{"/v1/images/generations", "/v1/images/edits"} {
		// A deliberately empty request makes the parser return 400 after authentication.
		if rec := request("POST", endpoint, `{}`, key); rec.Code != 400 {
			t.Errorf("scoped key on %s = %d", endpoint, rec.Code)
		}
		changed := "A"
		if strings.HasSuffix(key, changed) {
			changed = "E"
		}
		if rec := request("POST", endpoint, `{}`, key[:len(key)-1]+changed); rec.Code != 401 {
			t.Errorf("modified key on %s = %d", endpoint, rec.Code)
		}
	}
	for _, protected := range []struct{ method, path string }{
		{"GET", keys}, {"GET", path}, {"POST", keys}, {"DELETE", path},
		{"GET", "/admin/api/accounts"}, {"GET", "/admin/api/settings"},
		{"GET", "/admin/api/gallery"}, {"GET", "/admin/api/storage"},
		{"GET", "/admin/api/session"}, {"POST", "/admin/api/session/revoke"},
		{"POST", "/admin/api/images/generations"},
	} {
		if rec := request(protected.method, protected.path, `{}`, key); rec.Code != 401 {
			t.Errorf("scoped key on %s %s = %d", protected.method, protected.path, rec.Code)
		}
	}
	if rec := request("POST", "/admin/api/session", fmt.Sprintf(`{"apiKey":%q}`, key), ""); rec.Code != 401 || len(rec.Result().Cookies()) != 0 {
		t.Fatal("generation key granted an admin session")
	}
	handler = build("new-admin-key")
	if rec := request("POST", "/v1/images/generations", `{}`, key); rec.Code != 401 || retrieve("new-admin-key") == key {
		t.Fatal("rotating admin key did not rotate shared credentials")
	}
	handler = build(adminKey)
	if rec := request("DELETE", path, "", adminKey); rec.Code != 204 {
		t.Fatalf("revoke status = %d", rec.Code)
	}
	if rec := request("GET", path, "", adminKey); rec.Code != 404 {
		t.Fatalf("revoked key still retrievable: %d", rec.Code)
	}
	if rec := request("POST", "/v1/images/generations", `{}`, key); rec.Code != 401 {
		t.Fatalf("revoked credential status = %d", rec.Code)
	}
	if rec := request("POST", "/v1/images/generations", `{}`, adminKey); rec.Code != 400 {
		t.Fatalf("administrator request status = %d", rec.Code)
	}
	logs := request("GET", "/admin/api/logs?category=request", "", adminKey)
	if logs.Code != 200 || strings.Contains(logs.Body.String(), key) || strings.Contains(logs.Body.String(), adminKey) {
		t.Fatal("logs are unavailable or contain a bearer credential")
	}
	var page domain.Page[domain.RequestLog]
	decodeBody(t, logs, &page)
	if len(page.Items) != 3 || page.Items[0].APIKeyName != "PROXY_API_KEY" ||
		page.Items[1].APIKeyName != "客户端" || page.Items[2].APIKeyName != "客户端" {
		t.Fatalf("unexpected request log attributions: %+v", page.Items)
	}
}
