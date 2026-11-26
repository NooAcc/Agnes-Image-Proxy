package httpapi

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// SessionCookieName is the admin session cookie.
const SessionCookieName = "agnes_session"

const maxAdminJSONBytes = 1 << 20

type apiKeyNameContextKey struct{}

// AuthOptions wires the authentication boundaries.
type AuthOptions struct {
	APIKey              string
	LookupGenerationKey func(context.Context, string) (domain.GenerationKey, error)
	Sessions            *auth.Sessions
	Limiter             *auth.Limiter
	AllowedOrigins      []string
	TrustedProxies      []*net.IPNet
	// PublicOrigin, when set, is the only origin the admin plane accepts for
	// cookie mutations. It removes the dependency on trusted proxy headers.
	PublicOrigin string
	Now          func() time.Time
}

// Auth accepts scoped generation keys only on the data plane. Admin access
// requires the configured administrator key or a signed session cookie.
type Auth struct {
	apiKey              string
	generationKeys      auth.GenerationKeys
	lookupGenerationKey func(context.Context, string) (domain.GenerationKey, error)
	sessions            *auth.Sessions
	limiter             *auth.Limiter
	allowedOrigins      map[string]bool
	trustedProxies      []*net.IPNet
	publicOrigin        string
	publicScheme        string
	now                 func() time.Time
}

// NewAuth builds the authentication middleware set.
func NewAuth(options AuthOptions) *Auth {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	origins := make(map[string]bool, len(options.AllowedOrigins))
	for _, origin := range options.AllowedOrigins {
		if normalized := normalizeOrigin(origin); normalized != "" {
			origins[normalized] = true
		}
	}
	publicOrigin, _ := domain.NormalizePublicOrigin(options.PublicOrigin)
	publicScheme, _, _ := strings.Cut(publicOrigin, "://")
	return &Auth{
		apiKey:              options.APIKey,
		generationKeys:      auth.NewGenerationKeys(options.APIKey),
		lookupGenerationKey: options.LookupGenerationKey,
		sessions:            options.Sessions,
		limiter:             options.Limiter,
		allowedOrigins:      origins,
		trustedProxies:      options.TrustedProxies,
		publicOrigin:        publicOrigin,
		publicScheme:        publicScheme,
		now:                 now,
	}
}

// Data wraps a data-plane handler. Only an Authorization Bearer key is
// accepted; session cookies never reach the images API.
func (a *Auth) Data(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.corsHeaders(w, r)
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		key := bearerKey(r)
		valid := a.adminKeyValid(key)
		name := "PROXY_API_KEY"
		if !valid && a.lookupGenerationKey != nil {
			if id, ok := auth.GenerationKeyID(key); ok {
				stored, err := a.lookupGenerationKey(r.Context(), id)
				if err != nil {
					apierror.Write(w, err)
					return
				}
				valid = a.generationKeys.Verify(key, id, stored.Salt)
				name = stored.Name
			}
		}
		if !valid {
			apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "invalid API key", "invalid_request_error", "invalid_api_key").
				WithHeader("WWW-Authenticate", "Bearer"))
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), apiKeyNameContextKey{}, name)))
	})
}

// Admin wraps a management handler. A Bearer key needs no Origin; a cookie
// mutation must present the exact external origin, and near-expiry cookie
// requests are renewed.
func (a *Auth) Admin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Header.Get("Authorization") != "" {
			if !a.adminKeyValid(bearerKey(r)) {
				apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "invalid API key", "invalid_request_error", "invalid_api_key"))
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		cookie, err := r.Cookie(SessionCookieName)
		if err != nil {
			apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "authentication required", "invalid_request_error", "unauthorized"))
			return
		}
		if _, err := a.sessions.Verify(r.Context(), cookie.Value); err != nil {
			a.clearSessionCookie(w, r)
			apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "session is invalid", "invalid_request_error", "unauthorized"))
			return
		}
		if isMutation(r.Method) && !a.sameOrigin(r) {
			apierror.Write(w, apierror.Coded(http.StatusForbidden, "cross-origin request rejected", "invalid_request_error", "origin_forbidden"))
			return
		}
		a.renewSession(w, r, cookie.Value)
		next.ServeHTTP(w, r)
	})
}

// SessionHandler serves the session endpoints.
func (a *Auth) SessionHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /admin/api/session", a.handleLogin)
	mux.HandleFunc("GET /admin/api/session", a.handleSessionRead)
	mux.HandleFunc("DELETE /admin/api/session", a.handleLogout)
	mux.HandleFunc("POST /admin/api/session/revoke", a.handleRevoke)
	return mux
}

func (a *Auth) handleLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !a.limiter.Allow() {
		apierror.Write(w, apierror.Coded(http.StatusTooManyRequests, "too many failed login attempts", "invalid_request_error", "rate_limited").
			WithHeader("Retry-After", "60"))
		return
	}
	var body struct {
		APIKey string `json:"apiKey"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAdminJSONBytes))
	if err := decoder.Decode(&body); err != nil {
		apierror.Write(w, apierror.Invalid("apiKey", "request body must be JSON with apiKey", "invalid_value"))
		return
	}
	if !a.adminKeyValid(body.APIKey) {
		a.limiter.Failed()
		apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "invalid API key", "invalid_request_error", "invalid_api_key"))
		return
	}
	a.limiter.Reset()
	token, err := a.sessions.Issue(r.Context())
	if err != nil {
		apierror.Write(w, err)
		return
	}
	a.writeSessionCookie(w, r, token, 30*24*time.Hour)
	writeAdminJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}

func (a *Auth) handleSessionRead(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Header.Get("Authorization") != "" {
		if !a.adminKeyValid(bearerKey(r)) {
			apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "invalid API key", "invalid_request_error", "invalid_api_key"))
			return
		}
		writeAdminJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
		return
	}
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil {
		apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "authentication required", "invalid_request_error", "unauthorized"))
		return
	}
	if _, err := a.sessions.Verify(r.Context(), cookie.Value); err != nil {
		a.clearSessionCookie(w, r)
		apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "session is invalid", "invalid_request_error", "unauthorized"))
		return
	}
	a.renewSession(w, r, cookie.Value)
	writeAdminJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}

// handleLogout only clears this browser's cookie. Revoking every session is a
// separate, origin-checked action.
func (a *Auth) handleLogout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a.clearSessionCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (a *Auth) handleRevoke(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	viaCookie := false
	if r.Header.Get("Authorization") != "" {
		if !a.adminKeyValid(bearerKey(r)) {
			apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "invalid API key", "invalid_request_error", "invalid_api_key"))
			return
		}
	} else {
		cookie, err := r.Cookie(SessionCookieName)
		if err != nil {
			apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "authentication required", "invalid_request_error", "unauthorized"))
			return
		}
		if _, err := a.sessions.Verify(r.Context(), cookie.Value); err != nil {
			a.clearSessionCookie(w, r)
			apierror.Write(w, apierror.Coded(http.StatusUnauthorized, "session is invalid", "invalid_request_error", "unauthorized"))
			return
		}
		viaCookie = true
	}
	if viaCookie && !a.sameOrigin(r) {
		apierror.Write(w, apierror.Coded(http.StatusForbidden, "cross-origin request rejected", "invalid_request_error", "origin_forbidden"))
		return
	}
	if err := a.sessions.Revoke(r.Context()); err != nil {
		apierror.Write(w, err)
		return
	}
	a.clearSessionCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func bearerKey(r *http.Request) string {
	parts := strings.Fields(singleHeaderValue(r, "Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

func (a *Auth) adminKeyValid(key string) bool {
	return !strings.HasPrefix(key, auth.GenerationKeyPrefix) && auth.EqualSecret(key, a.apiKey)
}

// corsHeaders reflects only explicitly allowed origins and never enables
// credentialed CORS.
func (a *Auth) corsHeaders(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	normalized := normalizeOrigin(origin)
	if normalized == "" {
		return
	}
	w.Header().Add("Vary", "Origin")
	if a.allowedOrigins[normalized] {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
}

// renewSession issues a replacement cookie when the sliding window requires
// it. Renewal failures leave the current cookie in place.
func (a *Auth) renewSession(w http.ResponseWriter, r *http.Request, token string) {
	renewed, err := a.sessions.Renew(r.Context(), token)
	if err != nil || renewed == nil {
		return
	}
	next, err := a.sessions.Verify(r.Context(), *renewed)
	if err != nil {
		return
	}
	a.writeSessionCookie(w, r, *renewed, next.ExpiresAt.Sub(a.now()))
}

func (a *Auth) writeSessionCookie(w http.ResponseWriter, r *http.Request, token string, remaining time.Duration) {
	maxAge := int(remaining.Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/admin",
		MaxAge:   maxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.externalScheme(r) == "https",
	})
}

func (a *Auth) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/admin",
		MaxAge:   -1,
		Expires:  time.Unix(1, 0).UTC(),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.externalScheme(r) == "https",
	})
}

func writeAdminJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
