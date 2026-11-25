package domain_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

func ptr[T any](v T) *T { return &v }

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %q", code)
	}
	var ae *apierror.Error
	if !asAPIError(err, &ae) {
		t.Fatalf("expected API error, got %T: %v", err, err)
	}
	if ae.Status != 400 {
		t.Fatalf("status = %d, want 400", ae.Status)
	}
	if ae.Code == nil || *ae.Code != code {
		t.Fatalf("code = %v, want %q", ae.Code, code)
	}
}

func asAPIError(err error, target **apierror.Error) bool {
	ae, ok := err.(*apierror.Error)
	if ok {
		*target = ae
	}
	return ok
}

func TestStorageInitValidation(t *testing.T) {
	local, err := domain.ValidateStorageInit(domain.StorageInit{Mode: domain.StorageLocal})
	if err != nil || local.Mode != domain.StorageLocal || local.ImgbedBaseURL != "" || local.ImgbedToken != "" {
		t.Fatalf("local init = %+v, %v", local, err)
	}

	for name, in := range map[string]domain.StorageInit{
		"local with empty base":   {Mode: domain.StorageLocal, ImgbedBaseURL: ptr("")},
		"local with empty token":  {Mode: domain.StorageLocal, ImgbedToken: ptr("")},
		"local with base and tok": {Mode: domain.StorageLocal, ImgbedBaseURL: ptr("https://img.example.com"), ImgbedToken: ptr("t")},
		"unknown mode":            {Mode: domain.StorageMode("s3")},
		"empty mode":              {Mode: ""},
		"imgbed missing base":     {Mode: domain.StorageImgbed, ImgbedToken: ptr("t")},
		"imgbed missing token":    {Mode: domain.StorageImgbed, ImgbedBaseURL: ptr("https://img.example.com")},
		"imgbed blank token":      {Mode: domain.StorageImgbed, ImgbedBaseURL: ptr("https://img.example.com"), ImgbedToken: ptr("   ")},
	} {
		if _, err := domain.ValidateStorageInit(in); err == nil {
			t.Fatalf("%s: expected rejection", name)
		}
	}

	cfg, err := domain.ValidateStorageInit(domain.StorageInit{
		Mode:          domain.StorageImgbed,
		ImgbedBaseURL: ptr("https://IMG.Example.com:443/"),
		ImgbedToken:   ptr("  secret-token  "),
	})
	if err != nil {
		t.Fatalf("valid imgbed init: %v", err)
	}
	if cfg.ImgbedBaseURL != "https://img.example.com" || cfg.ImgbedToken != "secret-token" {
		t.Fatalf("normalized config = %+v", cfg)
	}
}

func TestStorageInitTokenLimits(t *testing.T) {
	base := ptr("https://img.example.com")
	for name, token := range map[string]string{
		"4096 bytes": strings.Repeat("a", 4096),
		"unicode":    "令牌-token",
	} {
		if _, err := domain.ValidateStorageInit(domain.StorageInit{Mode: domain.StorageImgbed, ImgbedBaseURL: base, ImgbedToken: &token}); err != nil {
			t.Fatalf("%s: unexpected rejection: %v", name, err)
		}
	}
	for name, token := range map[string]string{
		"4097 bytes": strings.Repeat("a", 4097),
		"carriage":   "a\rb",
		"newline":    "a\nb",
		"nul":        "a\x00b",
		"del":        "a\x7fb",
	} {
		if _, err := domain.ValidateStorageInit(domain.StorageInit{Mode: domain.StorageImgbed, ImgbedBaseURL: base, ImgbedToken: &token}); err == nil {
			t.Fatalf("%s: expected rejection", name)
		}
	}
}

func TestNormalizeImgbedBaseURL(t *testing.T) {
	for raw, want := range map[string]string{
		"https://img.example.com":         "https://img.example.com",
		"https://img.example.com/":        "https://img.example.com",
		"https://IMG.Example.com:443/":    "https://img.example.com",
		"https://img.example.com:8443":    "https://img.example.com:8443",
		"https://[2001:4860:4860::8888]/": "https://[2001:4860:4860::8888]",
	} {
		got, err := domain.NormalizeImgbedBaseURL(raw)
		if err != nil || got != want {
			t.Fatalf("%q -> %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{
		"", "   ", "http://img.example.com", "ftp://img.example.com",
		"https://img.example.com/upload", "https://img.example.com/?a=1",
		"https://img.example.com/#frag", "https://user:pass@img.example.com",
		"https://img.example.com:0", "https://img.example.com:99999",
		"https://img.example.com:", "https:///path", "https://img example.com",
	} {
		if _, err := domain.NormalizeImgbedBaseURL(raw); err == nil {
			t.Fatalf("%q: expected rejection", raw)
		}
	}
}

func TestStorageStatusJSON(t *testing.T) {
	cases := []struct {
		status domain.StorageStatus
		want   string
	}{
		{domain.StorageStatus{}, `{"initialized":false}`},
		{domain.StorageStatus{Initialized: true, Mode: domain.StorageLocal}, `{"initialized":true,"mode":"local"}`},
		{domain.StorageConfig{Mode: domain.StorageImgbed, ImgbedBaseURL: "https://img.example.com", ImgbedToken: "t"}.Status(), `{"initialized":true,"mode":"imgbed","imgbedBaseUrl":"https://img.example.com","hasImgbedToken":true}`},
	}
	for _, c := range cases {
		raw, err := json.Marshal(c.status)
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != c.want {
			t.Fatalf("status JSON = %s, want %s", raw, c.want)
		}
	}
}

func TestStorageConfigNeverSerializesSecrets(t *testing.T) {
	raw, err := json.Marshal(domain.StorageConfig{Mode: domain.StorageImgbed, ImgbedBaseURL: "https://img.example.com", ImgbedToken: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "{}" {
		t.Fatalf("config JSON leaked fields: %s", raw)
	}
}

func TestStorageUpdateValidation(t *testing.T) {
	in := domain.StorageUpdate{ImgbedBaseURL: "https://IMG.example.com/", ImgbedToken: ptr("  tok  ")}
	got, keep, err := domain.ValidateStorageUpdate(in)
	if err != nil {
		t.Fatal(err)
	}
	if got.ImgbedBaseURL != "https://img.example.com" || keep || got.ImgbedToken != "tok" {
		t.Fatalf("update = %+v keep=%v", got, keep)
	}

	empty := ""
	got, keep, err = domain.ValidateStorageUpdate(domain.StorageUpdate{ImgbedBaseURL: "https://img.example.com", ImgbedToken: &empty})
	if err != nil || !keep || got.ImgbedToken != "" {
		t.Fatalf("empty token should retain: %+v keep=%v err=%v", got, keep, err)
	}
	if _, _, err := domain.ValidateStorageUpdate(domain.StorageUpdate{ImgbedBaseURL: "http://img.example.com"}); err == nil {
		t.Fatal("expected invalid base URL rejection")
	}
}
