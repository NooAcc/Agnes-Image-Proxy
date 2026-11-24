package config_test

import (
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/config"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func validEnv() map[string]string {
	return map[string]string{
		"PROXY_API_KEY":      "test-key",
		"TURSO_DATABASE_URL": "libsql://example.turso.io",
		"TURSO_AUTH_TOKEN":   "token",
	}
}

func TestConfigRequired(t *testing.T) {
	for _, key := range []string{"PROXY_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"} {
		t.Run(key, func(t *testing.T) {
			m := validEnv()
			delete(m, key)
			if _, err := config.Load(env(m)); err == nil {
				t.Fatalf("missing %s should be rejected", key)
			}
		})
	}
	t.Run("blank", func(t *testing.T) {
		m := validEnv()
		m["PROXY_API_KEY"] = "   "
		if _, err := config.Load(env(m)); err == nil {
			t.Fatal("blank key should be rejected")
		}
	})
}

func TestConfigDefaults(t *testing.T) {
	cfg, err := config.Load(env(validEnv()))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 8000 {
		t.Fatalf("port = %d", cfg.Port)
	}
	if cfg.MaxInFlight != 8 || cfg.ArchiveWorkers != 4 || cfg.ArchiveCapacity != 32 {
		t.Fatalf("resource defaults: %+v", cfg)
	}
	if cfg.ShutdownTimeout != 120*time.Second {
		t.Fatalf("shutdown timeout = %v", cfg.ShutdownTimeout)
	}
	if len(cfg.CORSAllowedOrigins) != 0 || len(cfg.TrustedProxyCIDRs) != 0 {
		t.Fatalf("expected empty lists: %+v", cfg)
	}
}

func TestConfigPortValidation(t *testing.T) {
	for _, v := range []string{"abc", "0", "65536", "-1"} {
		m := validEnv()
		m["PORT"] = v
		if _, err := config.Load(env(m)); err == nil {
			t.Fatalf("port %q should be rejected", v)
		}
	}
	m := validEnv()
	m["PORT"] = "9000"
	cfg, err := config.Load(env(m))
	if err != nil || cfg.Port != 9000 {
		t.Fatalf("expected port 9000, got %+v err=%v", cfg, err)
	}
}

func TestConfigCORSValidation(t *testing.T) {
	m := validEnv()
	m["CORS_ALLOWED_ORIGINS"] = "https://app.example.com, http://localhost:5173"
	cfg, err := config.Load(env(m))
	if err != nil {
		t.Fatalf("valid origins rejected: %v", err)
	}
	if len(cfg.CORSAllowedOrigins) != 2 || cfg.CORSAllowedOrigins[0] != "https://app.example.com" || cfg.CORSAllowedOrigins[1] != "http://localhost:5173" {
		t.Fatalf("unexpected origins: %v", cfg.CORSAllowedOrigins)
	}

	for _, bad := range []string{
		"https://app.example.com/path",
		"https://user:pass@app.example.com",
		"https://app.example.com?x=1",
		"https://app.example.com#frag",
		"app.example.com",
		"ftp://app.example.com",
		"https://",
	} {
		m := validEnv()
		m["CORS_ALLOWED_ORIGINS"] = bad
		if _, err := config.Load(env(m)); err == nil {
			t.Fatalf("origin %q should be rejected", bad)
		}
	}
}

func TestConfigTrustedProxyCIDRs(t *testing.T) {
	m := validEnv()
	m["TRUSTED_PROXY_CIDRS"] = "10.0.0.0/8, 127.0.0.1/32"
	cfg, err := config.Load(env(m))
	if err != nil {
		t.Fatalf("valid cidrs rejected: %v", err)
	}
	if len(cfg.TrustedProxyCIDRs) != 2 {
		t.Fatalf("cidrs = %v", cfg.TrustedProxyCIDRs)
	}
	m["TRUSTED_PROXY_CIDRS"] = "not-a-cidr"
	if _, err := config.Load(env(m)); err == nil {
		t.Fatal("invalid cidr should be rejected")
	}
}

func TestConfigResourceValidation(t *testing.T) {
	m := validEnv()
	m["MAX_IN_FLIGHT"] = "0"
	if _, err := config.Load(env(m)); err == nil {
		t.Fatal("zero max in flight should be rejected")
	}
	m = validEnv()
	m["ARCHIVE_WORKERS"] = "8"
	m["ARCHIVE_CAPACITY"] = "4"
	if _, err := config.Load(env(m)); err == nil {
		t.Fatal("capacity below workers should be rejected")
	}
	m = validEnv()
	m["SHUTDOWN_TIMEOUT_SECONDS"] = "-5"
	if _, err := config.Load(env(m)); err == nil {
		t.Fatal("negative shutdown timeout should be rejected")
	}
}

func TestConfigTrimsSecrets(t *testing.T) {
	m := validEnv()
	m["PROXY_API_KEY"] = "  key  "
	cfg, err := config.Load(env(m))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.TrimSpace(cfg.ProxyAPIKey) != "key" {
		t.Fatalf("key not trimmed: %q", cfg.ProxyAPIKey)
	}
}
