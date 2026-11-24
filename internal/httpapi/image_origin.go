package httpapi

import (
	"net/http"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// ImageOrigin validates the final public authority before any generation is charged.
// Unlike cookie origin derivation, ambiguous trusted forwarding is an error, not
// a fallback to an internal address.
func (a *Auth) ImageOrigin(req *http.Request, settings domain.Settings) (string, error) {
	invalid := func() (string, error) {
		return "", apierror.Invalid("imagePublicBaseUrl", "a valid public image origin is required", "invalid_image_origin")
	}
	if settings.ImagePublicBaseURL != "" {
		origin, err := domain.NormalizeImageOrigin(settings.ImagePublicBaseURL)
		if err != nil || origin == "" {
			return invalid()
		}
		return origin, nil
	}
	host := req.Host
	if !validForwardedHost(host) {
		return invalid()
	}
	if values := req.Header.Values("Host"); len(values) > 0 {
		if len(values) != 1 || strings.Contains(values[0], ",") || values[0] != host {
			return invalid()
		}
	}
	scheme := "http"
	if req.TLS != nil {
		scheme = "https"
	}
	if a.isTrustedProxy(req) {
		for _, name := range []string{"X-Forwarded-Proto", "X-Forwarded-Host"} {
			if values := req.Header.Values(name); len(values) > 0 {
				if len(values) != 1 || singleHeaderValue(req, name) == "" {
					return invalid()
				}
			}
		}
		if values := req.Header.Values("X-Forwarded-Proto"); len(values) > 0 {
			value := singleHeaderValue(req, "X-Forwarded-Proto")
			if value != "http" && value != "https" {
				return invalid()
			}
			if req.TLS == nil {
				scheme = value
			}
		}
		if values := req.Header.Values("X-Forwarded-Host"); len(values) > 0 {
			host = singleHeaderValue(req, "X-Forwarded-Host")
			if !validForwardedHost(host) {
				return invalid()
			}
		}
	}
	origin, err := domain.NormalizeImageOrigin(scheme + "://" + host)
	if err != nil || origin == "" {
		return invalid()
	}
	return origin, nil
}
