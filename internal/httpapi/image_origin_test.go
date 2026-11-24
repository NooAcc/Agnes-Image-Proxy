package httpapi_test

import (
	"crypto/tls"
	"errors"
	"net"
	"net/http/httptest"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
)

func TestImageOrigin(t *testing.T) {
	_, network, _ := net.ParseCIDR("10.0.0.0/8")
	guard := httpapi.NewAuth(httpapi.AuthOptions{TrustedProxies: []*net.IPNet{network}})
	for _, tc := range []struct {
		name, host, peer, proto, forward, configured, want string
		tls                                                bool
	}{
		{name: "explicit", host: "untrusted.invalid", configured: "https://images.example.com/", want: "https://images.example.com"},
		{name: "direct TLS", host: "images.example.com", tls: true, want: "https://images.example.com"},
		{name: "local", host: "127.0.0.1:8080", want: "http://127.0.0.1:8080"},
		{name: "trusted", host: "backend:8080", peer: "10.0.0.1:80", proto: "https", forward: "images.example.com", want: "https://images.example.com"},
		{name: "untrusted", host: "images.example.com", tls: true, peer: "192.0.2.1:80", proto: "http", forward: "evil.example.com", want: "https://images.example.com"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "http://localhost/", nil)
			req.Host = tc.host
			req.RemoteAddr = tc.peer
			if tc.tls {
				req.TLS = &tls.ConnectionState{}
			}
			if tc.proto != "" {
				req.Header.Set("X-Forwarded-Proto", tc.proto)
			}
			if tc.forward != "" {
				req.Header.Set("X-Forwarded-Host", tc.forward)
			}
			settings := domain.DefaultSettings()
			settings.ImagePublicBaseURL = tc.configured
			got, err := guard.ImageOrigin(req, settings)
			if err != nil || got != tc.want {
				t.Fatalf("%q %v", got, err)
			}
		})
	}
}
func TestImageOriginRejectsAmbiguousAuthority(t *testing.T) {
	_, network, _ := net.ParseCIDR("10.0.0.0/8")
	guard := httpapi.NewAuth(httpapi.AuthOptions{TrustedProxies: []*net.IPNet{network}})
	for _, host := range []string{"https://images.example.com", "user@images.example.com", "images.example.com/path", "images.example.com\r\nX: y", "images.example.com,evil.example.com", "images.example.com:99999"} {
		req := httptest.NewRequest("POST", "https://localhost/", nil)
		req.Host = host
		_, err := guard.ImageOrigin(req, domain.DefaultSettings())
		var ae *apierror.Error
		if !errors.As(err, &ae) || ae.Status != 400 {
			t.Fatalf("host %q: %v", host, err)
		}
	}
	req := httptest.NewRequest("POST", "http://images.example.com/", nil)
	if _, err := guard.ImageOrigin(req, domain.DefaultSettings()); err == nil {
		t.Fatal("non-loopback HTTP accepted")
	}
	for _, name := range []string{"X-Forwarded-Proto", "X-Forwarded-Host", "Host"} {
		for _, duplicate := range []bool{false, true} {
			req := httptest.NewRequest("POST", "http://localhost/", nil)
			req.RemoteAddr = "10.0.0.1:80"
			req.Header.Set("X-Forwarded-Proto", "https")
			req.Header.Set("X-Forwarded-Host", "images.example.com")
			if name == "Host" {
				req.Header.Set(name, "images.example.com")
			}
			if duplicate {
				req.Header.Add(name, "evil")
			} else {
				req.Header.Set(name, "https,evil")
			}
			if _, err := guard.ImageOrigin(req, domain.DefaultSettings()); err == nil {
				t.Fatalf("ambiguous %s accepted", name)
			}
		}
	}
}
