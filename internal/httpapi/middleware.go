package httpapi

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// isTrustedProxy reports whether RemoteAddr belongs to a configured trusted
// reverse-proxy network. Forwarded headers are ignored for every other peer.
func (a *Auth) isTrustedProxy(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, network := range a.trustedProxies {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// externalScheme derives the scheme the browser used.
func (a *Auth) externalScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if a.isTrustedProxy(r) {
		if value := singleHeaderValue(r, "X-Forwarded-Proto"); value == "http" || value == "https" {
			return value
		}
	}
	return "http"
}

// externalHost derives the host the browser used.
func (a *Auth) externalHost(r *http.Request) string {
	if a.isTrustedProxy(r) {
		if value := singleHeaderValue(r, "X-Forwarded-Host"); validForwardedHost(value) {
			return value
		}
	}
	return r.Host
}

// externalOrigin is the exact origin a same-site mutation must present.
func (a *Auth) externalOrigin(r *http.Request) string {
	return a.externalScheme(r) + "://" + strings.ToLower(a.externalHost(r))
}

// sameOrigin requires the Origin header to match the derived external origin.
// Missing or malformed origins never match.
func (a *Auth) sameOrigin(r *http.Request) bool {
	origin := normalizeOrigin(r.Header.Get("Origin"))
	if origin == "" {
		return false
	}
	return origin == normalizeOrigin(a.externalOrigin(r))
}

// normalizeOrigin canonicalizes a serialized origin and rejects values with a
// path, query, fragment or credentials.
func normalizeOrigin(raw string) string {
	if raw == "" || strings.ContainsAny(raw, " \t\r\n,") {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" || parsed.Host == "" {
		return ""
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return ""
	}
	return parsed.Scheme + "://" + strings.ToLower(parsed.Host)
}

// singleHeaderValue returns the header value only when exactly one value was
// sent without a comma-separated list.
func singleHeaderValue(r *http.Request, name string) string {
	values := r.Header.Values(name)
	if len(values) != 1 || strings.Contains(values[0], ",") {
		return ""
	}
	return strings.TrimSpace(values[0])
}

func validForwardedHost(value string) bool {
	if value == "" || strings.ContainsAny(value, " \t\r\n/\\@,#?") {
		return false
	}
	parsed, err := url.Parse("http://" + value)
	if err != nil || parsed.Host != value || parsed.User != nil || parsed.Path != "" {
		return false
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	return true
}

func isMutation(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}
