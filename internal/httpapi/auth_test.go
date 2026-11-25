package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
)

type testEpochs struct {
	mu    sync.Mutex
	epoch int64
	bumps int
}

func (f *testEpochs) SessionEpoch(context.Context) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.epoch, nil
}

func (f *testEpochs) BumpSessionEpoch(context.Context) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.epoch++
	f.bumps++
	return f.epoch, nil
}

type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func newTestClock() *testClock {
	return &testClock{t: time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)}
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type testEnv struct {
	auth     *httpapi.Auth
	sessions *auth.Sessions
	epochs   *testEpochs
	limiter  *auth.Limiter
	clock    *testClock
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	epochs := &testEpochs{epoch: 1}
	clock := newTestClock()
	sessions := auth.NewSessions("master-key", epochs, clock.Now)
	limiter := auth.NewLimiter(clock.Now)
	return &testEnv{
		auth: httpapi.NewAuth(httpapi.AuthOptions{
			APIKey:         "secret-key",
			Sessions:       sessions,
			Limiter:        limiter,
			AllowedOrigins: []string{"https://app.example"},
			TrustedProxies: mustCIDRs(t, "10.0.0.0/8"),
		}),
		sessions: sessions,
		epochs:   epochs,
		limiter:  limiter,
		clock:    clock,
	}
}

func authLimiter(t *testing.T) *auth.Limiter {
	t.Helper()
	return auth.NewLimiter(newTestClock().Now)
}

func newSessionsForTest(t *testing.T) *auth.Sessions {
	t.Helper()
	return auth.NewSessions("master-key", &testEpochs{epoch: 1}, newTestClock().Now)
}

func mustCIDRs(t *testing.T, values ...string) []*net.IPNet {
	t.Helper()
	var out []*net.IPNet
	for _, value := range values {
		_, network, err := net.ParseCIDR(value)
		if err != nil {
			t.Fatalf("cidr %q: %v", value, err)
		}
		out = append(out, network)
	}
	return out
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
}

func (e *testEnv) login(t *testing.T, apiKey string) *http.Response {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"apiKey": apiKey})
	req := httptest.NewRequest(http.MethodPost, "/admin/api/session", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.auth.SessionHandler().ServeHTTP(rec, req)
	return rec.Result()
}

func (e *testEnv) loginCookie(t *testing.T) *http.Cookie {
	t.Helper()
	resp := e.login(t, "secret-key")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", resp.StatusCode)
	}
	cookies := resp.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %v", cookies)
	}
	return cookies[0]
}

func request(method, target string, body []byte) *http.Request {
	var reader *bytes.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	req.RemoteAddr = "192.0.2.10:1234"
	return req
}

func call(handler http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestSessionCookieCannotCallDataPlane(t *testing.T) {
	env := newTestEnv(t)
	cookie := env.loginCookie(t)
	handler := env.auth.Data(okHandler())

	req := request(http.MethodPost, "/v1/images/generations", []byte("{}"))
	req.AddCookie(cookie)
	if rec := call(handler, req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("cookie data-plane status = %d", rec.Code)
	}

	req = request(http.MethodPost, "/v1/images/generations", []byte("{}"))
	req.Header.Set("Authorization", "Bearer secret-key")
	if rec := call(handler, req); rec.Code != http.StatusOK {
		t.Fatalf("bearer data-plane status = %d", rec.Code)
	}

	req = request(http.MethodPost, "/v1/images/generations", []byte("{}"))
	req.Header.Set("Authorization", "Bearer wrong")
	req.AddCookie(cookie)
	if rec := call(handler, req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad bearer status = %d", rec.Code)
	}
}

func TestSessionBearerManagesAdmin(t *testing.T) {
	env := newTestEnv(t)
	handler := env.auth.Admin(okHandler())

	req := request(http.MethodPost, "/admin/api/settings", []byte("{}"))
	if rec := call(handler, req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous admin status = %d", rec.Code)
	} else if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("admin error cache-control = %q", rec.Header().Get("Cache-Control"))
	}

	req = request(http.MethodPatch, "/admin/api/accounts/1", []byte("{}"))
	req.Header.Set("Authorization", "Bearer secret-key")
	req.Header.Set("Origin", "https://evil.example")
	if rec := call(handler, req); rec.Code != http.StatusOK {
		t.Fatalf("bearer admin status = %d", rec.Code)
	}

	req = request(http.MethodGet, "/admin/api/accounts", nil)
	req.AddCookie(env.loginCookie(t))
	if rec := call(handler, req); rec.Code != http.StatusOK {
		t.Fatalf("cookie admin status = %d", rec.Code)
	}
}

func TestOriginCookieMutations(t *testing.T) {
	env := newTestEnv(t)
	cookie := env.loginCookie(t)
	handler := env.auth.Admin(okHandler())

	req := request(http.MethodPatch, "/admin/api/accounts/1", []byte("{}"))
	req.AddCookie(cookie)
	if rec := call(handler, req); rec.Code != http.StatusForbidden {
		t.Fatalf("missing origin status = %d", rec.Code)
	}

	req = request(http.MethodPatch, "/admin/api/accounts/1", []byte("{}"))
	req.AddCookie(cookie)
	req.Header.Set("Origin", "https://evil.example")
	if rec := call(handler, req); rec.Code != http.StatusForbidden {
		t.Fatalf("cross origin status = %d", rec.Code)
	}

	req = request(http.MethodPatch, "/admin/api/accounts/1", []byte("{}"))
	req.AddCookie(cookie)
	req.Header.Set("Origin", "http://example.com")
	if rec := call(handler, req); rec.Code != http.StatusOK {
		t.Fatalf("same origin status = %d", rec.Code)
	}

	// GET requests do not need an Origin.
	req = request(http.MethodGet, "/admin/api/accounts", nil)
	req.AddCookie(cookie)
	if rec := call(handler, req); rec.Code != http.StatusOK {
		t.Fatalf("cookie GET status = %d", rec.Code)
	}
}

func TestProxyOriginDerivation(t *testing.T) {
	env := newTestEnv(t)
	cookie := env.loginCookie(t)
	handler := env.auth.Admin(okHandler())

	proxied := func() *http.Request {
		req := request(http.MethodPatch, "/admin/api/accounts/1", []byte("{}"))
		req.AddCookie(cookie)
		req.Host = "internal:8080"
		req.RemoteAddr = "10.1.2.3:5555"
		req.Header.Set("X-Forwarded-Proto", "https")
		req.Header.Set("X-Forwarded-Host", "admin.example.com")
		return req
	}

	req := proxied()
	req.Header.Set("Origin", "https://admin.example.com")
	if rec := call(handler, req); rec.Code != http.StatusOK {
		t.Fatalf("trusted proxy origin status = %d", rec.Code)
	}

	// Forwarded headers from an untrusted address are ignored.
	req = proxied()
	req.RemoteAddr = "203.0.113.9:1234"
	req.Header.Set("Origin", "https://admin.example.com")
	if rec := call(handler, req); rec.Code != http.StatusForbidden {
		t.Fatalf("spoofed forwarded origin status = %d", rec.Code)
	}
	req = proxied()
	req.RemoteAddr = "203.0.113.9:1234"
	req.Header.Set("Origin", "http://internal:8080")
	if rec := call(handler, req); rec.Code != http.StatusOK {
		t.Fatalf("direct origin status = %d", rec.Code)
	}

	// Multi-valued or malformed forwarded headers are ignored.
	req = proxied()
	req.Header.Set("X-Forwarded-Proto", "https, http")
	req.Header.Set("Origin", "https://admin.example.com")
	if rec := call(handler, req); rec.Code != http.StatusForbidden {
		t.Fatalf("multi-valued proto accepted: %d", rec.Code)
	}
	req = proxied()
	req.Header.Set("X-Forwarded-Host", "bad host")
	req.Header.Set("Origin", "https://admin.example.com")
	if rec := call(handler, req); rec.Code != http.StatusForbidden {
		t.Fatalf("invalid forwarded host accepted: %d", rec.Code)
	}
}

func TestLoginCookieAttributes(t *testing.T) {
	env := newTestEnv(t)
	resp := env.login(t, "secret-key")
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("login response = %d cache=%q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
	cookie := resp.Cookies()[0]
	if cookie.Name != httpapi.SessionCookieName || !cookie.HttpOnly || cookie.Path != "/admin" ||
		cookie.SameSite != http.SameSiteLaxMode || cookie.Secure {
		t.Fatalf("cookie = %+v", cookie)
	}
	if cookie.MaxAge <= 29*24*3600 {
		t.Fatalf("cookie max age = %d", cookie.MaxAge)
	}

	// A trusted TLS-terminating proxy makes the cookie Secure.
	body, _ := json.Marshal(map[string]string{"apiKey": "secret-key"})
	req := httptest.NewRequest(http.MethodPost, "/admin/api/session", bytes.NewReader(body))
	req.RemoteAddr = "10.1.2.3:5555"
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := call(env.auth.SessionHandler(), req)
	if rec.Code != http.StatusOK {
		t.Fatalf("proxied login status = %d", rec.Code)
	}
	if !rec.Result().Cookies()[0].Secure {
		t.Fatal("proxied https login cookie is not Secure")
	}
}

func TestLoginRateLimit(t *testing.T) {
	env := newTestEnv(t)
	for i := 0; i < 10; i++ {
		if resp := env.login(t, "wrong"); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("failure %d status = %d", i+1, resp.StatusCode)
		}
	}
	resp := env.login(t, "secret-key")
	if resp.StatusCode != http.StatusTooManyRequests || resp.Header.Get("Retry-After") != "60" {
		t.Fatalf("locked login = %d retry=%q", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
	env.clock.Advance(61 * time.Second)
	if resp := env.login(t, "secret-key"); resp.StatusCode != http.StatusOK {
		t.Fatalf("login after lockout = %d", resp.StatusCode)
	}
}

func TestSessionGETAndLogout(t *testing.T) {
	env := newTestEnv(t)
	cookie := env.loginCookie(t)

	req := request(http.MethodGet, "/admin/api/session", nil)
	req.AddCookie(cookie)
	rec := call(env.auth.SessionHandler(), req)
	if rec.Code != http.StatusOK {
		t.Fatalf("session GET = %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("session body: %v", err)
	}
	if body["authenticated"] != true || strings.Contains(rec.Body.String(), "token") {
		t.Fatalf("session body = %s", rec.Body.String())
	}

	req = request(http.MethodGet, "/admin/api/session", nil)
	if rec := call(env.auth.SessionHandler(), req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous session GET = %d", rec.Code)
	}

	req = request(http.MethodDelete, "/admin/api/session", nil)
	req.AddCookie(cookie)
	rec = call(env.auth.SessionHandler(), req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout = %d", rec.Code)
	}
	cleared := rec.Result().Cookies()
	if len(cleared) != 1 || cleared[0].MaxAge >= 0 {
		t.Fatalf("logout cookie = %v", cleared)
	}
	if env.epochs.bumps != 0 {
		t.Fatal("logout bumped the epoch; revoke is the separate action")
	}
}

func TestSessionRevoke(t *testing.T) {
	env := newTestEnv(t)
	cookie := env.loginCookie(t)

	req := request(http.MethodPost, "/admin/api/session/revoke", nil)
	req.AddCookie(cookie)
	if rec := call(env.auth.SessionHandler(), req); rec.Code != http.StatusForbidden {
		t.Fatalf("missing-origin revoke = %d", rec.Code)
	}

	req = request(http.MethodPost, "/admin/api/session/revoke", nil)
	req.AddCookie(cookie)
	req.Header.Set("Origin", "http://example.com")
	rec := call(env.auth.SessionHandler(), req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke = %d", rec.Code)
	}
	if env.epochs.bumps != 1 {
		t.Fatalf("bumps = %d", env.epochs.bumps)
	}

	req = request(http.MethodGet, "/admin/api/session", nil)
	req.AddCookie(cookie)
	if rec := call(env.auth.SessionHandler(), req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session GET = %d", rec.Code)
	}
}

func TestSessionRenewalOnlyForCookieRequests(t *testing.T) {
	env := newTestEnv(t)
	cookie := env.loginCookie(t)
	handler := env.auth.Admin(okHandler())

	env.clock.Advance(24 * 24 * time.Hour) // 6 days remaining
	req := request(http.MethodGet, "/admin/api/accounts", nil)
	req.AddCookie(cookie)
	rec := call(handler, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("cookie GET = %d", rec.Code)
	}
	renewed := rec.Result().Cookies()
	if len(renewed) != 1 || renewed[0].Value == cookie.Value {
		t.Fatalf("cookie not renewed: %v", renewed)
	}
	if _, err := env.sessions.Verify(context.Background(), renewed[0].Value); err != nil {
		t.Fatalf("renewed token invalid: %v", err)
	}

	req = request(http.MethodGet, "/admin/api/accounts", nil)
	req.Header.Set("Authorization", "Bearer secret-key")
	if rec := call(handler, req); len(rec.Result().Cookies()) != 0 {
		t.Fatal("bearer request triggered renewal")
	}

	req = request(http.MethodGet, "/admin/api/accounts", nil)
	req.AddCookie(renewed[0])
	if rec := call(handler, req); len(rec.Result().Cookies()) != 0 {
		t.Fatal("fresh cookie renewed again")
	}
}

func TestCORSAllowlist(t *testing.T) {
	env := newTestEnv(t)
	handler := env.auth.Data(okHandler())

	req := request(http.MethodPost, "/v1/images/generations", []byte("{}"))
	req.Header.Set("Authorization", "Bearer secret-key")
	req.Header.Set("Origin", "https://app.example")
	rec := call(handler, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("allowed origin status = %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example" {
		t.Fatalf("allow origin = %q", rec.Header().Get("Access-Control-Allow-Origin"))
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("CORS credentials enabled")
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Origin") {
		t.Fatalf("vary = %q", rec.Header().Get("Vary"))
	}

	req = request(http.MethodPost, "/v1/images/generations", []byte("{}"))
	req.Header.Set("Authorization", "Bearer secret-key")
	req.Header.Set("Origin", "https://evil.example")
	rec = call(handler, req)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("arbitrary origin allowed: %q", rec.Header().Get("Access-Control-Allow-Origin"))
	}

	req = request(http.MethodOptions, "/v1/images/generations", nil)
	req.Header.Set("Origin", "https://app.example")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec = call(handler, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight = %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example" ||
		!strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "POST") ||
		!strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatalf("preflight headers = %v", rec.Header())
	}
}

func newPublicOriginEnv(t *testing.T, origin string) *testEnv {
	t.Helper()
	env := newTestEnv(t)
	env.auth = httpapi.NewAuth(httpapi.AuthOptions{
		APIKey:         "secret-key",
		Sessions:       env.sessions,
		Limiter:        env.limiter,
		AllowedOrigins: []string{"https://app.example"},
		TrustedProxies: mustCIDRs(t, "10.0.0.0/8"),
		PublicOrigin:   origin,
	})
	return env
}

func TestPublicOriginOverridesProxyDerivation(t *testing.T) {
	env := newPublicOriginEnv(t, "https://admin.example.com")
	cookie := env.loginCookie(t)
	handler := env.auth.Admin(okHandler())

	// The fixed public origin authenticates even from an untrusted peer with
	// hostile forwarding headers.
	req := request(http.MethodPatch, "/admin/api/accounts/1", []byte("{}"))
	req.AddCookie(cookie)
	req.RemoteAddr = "203.0.113.9:1234"
	req.Header.Set("Origin", "https://admin.example.com")
	req.Header.Set("X-Forwarded-Proto", "http")
	req.Header.Set("X-Forwarded-Host", "evil.example")
	if rec := call(handler, req); rec.Code != http.StatusOK {
		t.Fatalf("fixed public origin status = %d", rec.Code)
	}

	// The request-derived origin is no longer accepted.
	req = request(http.MethodPatch, "/admin/api/accounts/1", []byte("{}"))
	req.AddCookie(cookie)
	req.Header.Set("Origin", "http://internal:8080")
	if rec := call(handler, req); rec.Code != http.StatusForbidden {
		t.Fatalf("derived origin status = %d", rec.Code)
	}

	req = request(http.MethodPatch, "/admin/api/accounts/1", []byte("{}"))
	req.AddCookie(cookie)
	req.Header.Set("Origin", "https://evil.example")
	if rec := call(handler, req); rec.Code != http.StatusForbidden {
		t.Fatalf("cross origin status = %d", rec.Code)
	}
}

func TestPublicOriginCookieSecure(t *testing.T) {
	env := newPublicOriginEnv(t, "https://admin.example.com")
	resp := env.login(t, "secret-key")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", resp.StatusCode)
	}
	if cookie := resp.Cookies()[0]; !cookie.Secure {
		t.Fatalf("cookie = %+v", cookie)
	}
}
