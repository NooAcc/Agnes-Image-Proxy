// Package config loads and validates process configuration from environment
// variables. Required secrets have no defaults.
package config

import (
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// Config is the validated process configuration.
type Config struct {
	ProxyAPIKey        string
	TursoDatabaseURL   string
	TursoAuthToken     string
	DataDir            string
	Port               int
	CORSAllowedOrigins []string
	TrustedProxyCIDRs  []*net.IPNet
	PublicOrigin       string
	MaxInFlight        int
	ArchiveWorkers     int
	ArchiveCapacity    int
	ShutdownTimeout    time.Duration
}

const (
	defaultPort            = 8000
	defaultMaxInFlight     = 8
	defaultArchiveWorkers  = 4
	defaultArchiveCapacity = 32
	defaultShutdownTimeout = 120 * time.Second
)

// Load reads configuration through getenv and validates it.
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		ProxyAPIKey:      strings.TrimSpace(getenv("PROXY_API_KEY")),
		TursoDatabaseURL: strings.TrimSpace(getenv("TURSO_DATABASE_URL")),
		TursoAuthToken:   strings.TrimSpace(getenv("TURSO_AUTH_TOKEN")),
		Port:             defaultPort,
		MaxInFlight:      defaultMaxInFlight,
		ArchiveWorkers:   defaultArchiveWorkers,
		ArchiveCapacity:  defaultArchiveCapacity,
		ShutdownTimeout:  defaultShutdownTimeout,
	}
	rawDataDir := getenv("DATA_DIR")
	cfg.DataDir = "/data"
	if rawDataDir != "" {
		if strings.TrimSpace(rawDataDir) == "" || (rawDataDir != "/data" && !filepath.IsAbs(rawDataDir)) {
			return Config{}, fmt.Errorf("DATA_DIR must be a non-empty absolute directory")
		}
		cfg.DataDir = rawDataDir
	}
	if cfg.ProxyAPIKey == "" {
		return Config{}, fmt.Errorf("PROXY_API_KEY is required")
	}
	if cfg.TursoDatabaseURL == "" {
		return Config{}, fmt.Errorf("TURSO_DATABASE_URL is required")
	}
	if cfg.TursoAuthToken == "" {
		return Config{}, fmt.Errorf("TURSO_AUTH_TOKEN is required")
	}

	if raw := strings.TrimSpace(getenv("PORT")); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("PORT must be an integer between 1 and 65535")
		}
		cfg.Port = port
	}

	origins, err := parseOrigins(getenv("CORS_ALLOWED_ORIGINS"))
	if err != nil {
		return Config{}, err
	}
	cfg.CORSAllowedOrigins = origins

	proxies, err := parseCIDRs(getenv("TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return Config{}, err
	}
	cfg.TrustedProxyCIDRs = proxies

	publicOrigin, err := domain.NormalizePublicOrigin(getenv("PUBLIC_ORIGIN"))
	if err != nil {
		return Config{}, err
	}
	cfg.PublicOrigin = publicOrigin

	if cfg.MaxInFlight, err = positiveInt(getenv, "MAX_IN_FLIGHT", defaultMaxInFlight); err != nil {
		return Config{}, err
	}
	if cfg.ArchiveWorkers, err = positiveInt(getenv, "ARCHIVE_WORKERS", defaultArchiveWorkers); err != nil {
		return Config{}, err
	}
	if cfg.ArchiveCapacity, err = positiveInt(getenv, "ARCHIVE_CAPACITY", defaultArchiveCapacity); err != nil {
		return Config{}, err
	}
	if cfg.ArchiveCapacity < cfg.ArchiveWorkers {
		return Config{}, fmt.Errorf("ARCHIVE_CAPACITY must be greater than or equal to ARCHIVE_WORKERS")
	}
	if raw := strings.TrimSpace(getenv("SHUTDOWN_TIMEOUT_SECONDS")); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds <= 0 {
			return Config{}, fmt.Errorf("SHUTDOWN_TIMEOUT_SECONDS must be a positive integer")
		}
		cfg.ShutdownTimeout = time.Duration(seconds) * time.Second
	}
	return cfg, nil
}

func positiveInt(getenv func(string) string, name string, fallback int) (int, error) {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func parseOrigins(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		u, err := url.Parse(part)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("CORS_ALLOWED_ORIGINS entry %q is not a complete origin", part)
		}
		if u.Scheme != "http" && u.Scheme != "https" {
			return nil, fmt.Errorf("CORS_ALLOWED_ORIGINS entry %q must use http or https", part)
		}
		if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return nil, fmt.Errorf("CORS_ALLOWED_ORIGINS entry %q must be an origin without path, query or credentials", part)
		}
		out = append(out, u.Scheme+"://"+u.Host)
	}
	return out, nil
}

func parseCIDRs(raw string) ([]*net.IPNet, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var out []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		_, network, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("TRUSTED_PROXY_CIDRS entry %q is not a valid CIDR", part)
		}
		out = append(out, network)
	}
	return out, nil
}
