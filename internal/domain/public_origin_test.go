package domain

import (
	"strings"
	"testing"
)

func TestNormalizePublicOrigin(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want string
	}{
		{"empty", "", ""},
		{"trailing slash", "https://Admin.Example.com/", "https://admin.example.com"},
		{"default port", "https://admin.example.com:443", "https://admin.example.com"},
		{"loopback http", "http://127.0.0.1:8000", "http://127.0.0.1:8000"},
		{"explicit port", "https://admin.example.com:8443", "https://admin.example.com:8443"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizePublicOrigin(tc.raw)
			if err != nil || got != tc.want {
				t.Fatalf("got %q, err %v; want %q", got, err, tc.want)
			}
		})
	}
	for _, raw := range []string{
		"http://admin.example.com",
		"https://admin.example.com/path",
		"https://admin.example.com?q=1",
		"https://admin.example.com#frag",
		"https://user@admin.example.com",
		"https://admin.example.com:99999",
	} {
		t.Run("reject "+raw, func(t *testing.T) {
			_, err := NormalizePublicOrigin(raw)
			if err == nil {
				t.Fatalf("%q accepted", raw)
			}
			if !strings.Contains(err.Error(), "PUBLIC_ORIGIN") {
				t.Fatalf("error %q does not name PUBLIC_ORIGIN", err)
			}
		})
	}
}
