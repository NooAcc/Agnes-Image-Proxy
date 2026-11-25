package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

// Settings is the single admin-editable configuration structure. It is stored
// as one JSON row; there is no legacy field mapping.
type Settings struct {
	AgnesBaseURL          string `json:"agnesBaseUrl"`
	DefaultSize           string `json:"defaultSize"`
	ImageParamMode        string `json:"imageParamMode"`
	ProbeModel            string `json:"probeModel"`
	ProbeConcurrency      int    `json:"probeConcurrency"`
	RequestTimeoutMS      int    `json:"requestTimeoutMs"`
	AutoRefreshIntervalMS int    `json:"autoRefreshIntervalMs"`
	MaxAttempts           int    `json:"maxAttempts"`
	ImageServiceBaseURL   string `json:"imageServiceBaseUrl"`
	ThumbnailWidth        int    `json:"thumbnailWidth"`
	ThumbnailQuality      int    `json:"thumbnailQuality"`
	EnrichTimeoutMS       int    `json:"enrichTimeoutMs"`
	ImageURLTTLHours      int    `json:"imageUrlTtlHours"`
	ImagePublicBaseURL    string `json:"imagePublicBaseUrl"`
}

// UnmarshalJSON rejects incomplete and unknown settings instead of supplying defaults.
func (s *Settings) UnmarshalJSON(data []byte) error {
	type plain Settings
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"imageUrlTtlHours", "imagePublicBaseUrl"} {
		value, ok := fields[key]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return settingError(key, key+" is required")
		}
	}
	var out plain
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&out); err != nil {
		return err
	}
	*s = Settings(out)
	return nil
}

// DefaultSettings returns the validated startup configuration.
func DefaultSettings() Settings {
	return Settings{
		AgnesBaseURL:          "https://apihub.agnes-ai.com/v1",
		DefaultSize:           "1K",
		ImageParamMode:        "nested",
		ProbeModel:            "agnes-image-2.5-flash",
		ProbeConcurrency:      2,
		RequestTimeoutMS:      300000,
		AutoRefreshIntervalMS: 5000,
		MaxAttempts:           3,
		ImageServiceBaseURL:   "",
		ThumbnailWidth:        640,
		ThumbnailQuality:      75,
		EnrichTimeoutMS:       60000,
		ImageURLTTLHours:      24,
		ImagePublicBaseURL:    "",
	}
}

func settingError(field, message string) *apierror.Error {
	return apierror.Invalid(field, message, "invalid_setting")
}

// ValidateSettings validates a complete settings structure and returns its
// normalized form. Missing or unknown fields are rejected by decoding, not
// silently defaulted.
func ValidateSettings(in Settings) (Settings, error) {
	out := in

	base, err := normalizeServiceURL(in.AgnesBaseURL, "agnesBaseUrl", true)
	if err != nil {
		return Settings{}, err
	}
	out.AgnesBaseURL = base

	imageService, err := normalizeServiceURL(in.ImageServiceBaseURL, "imageServiceBaseUrl", false)
	if err != nil {
		return Settings{}, err
	}
	out.ImageServiceBaseURL = imageService
	origin, err := NormalizeImageOrigin(in.ImagePublicBaseURL)
	if err != nil {
		return Settings{}, err
	}
	out.ImagePublicBaseURL = origin

	tier := strings.ToUpper(strings.TrimSpace(in.DefaultSize))
	switch tier {
	case "1K", "2K", "3K", "4K":
		out.DefaultSize = tier
	default:
		return Settings{}, settingError("defaultSize", "defaultSize must be one of 1K, 2K, 3K, 4K")
	}

	if in.ImageParamMode != "nested" && in.ImageParamMode != "top_level" {
		return Settings{}, settingError("imageParamMode", "imageParamMode must be nested or top_level")
	}

	out.ProbeModel = strings.TrimSpace(in.ProbeModel)
	if out.ProbeModel == "" {
		return Settings{}, settingError("probeModel", "probeModel must be a non-empty string")
	}

	ranges := []struct {
		field string
		value int
		min   int
		max   int
	}{
		{"probeConcurrency", in.ProbeConcurrency, 1, 10},
		{"autoRefreshIntervalMs", in.AutoRefreshIntervalMS, 2000, 60000},
		{"maxAttempts", in.MaxAttempts, 1, 10},
		{"requestTimeoutMs", in.RequestTimeoutMS, 60000, 360000},
		{"thumbnailWidth", in.ThumbnailWidth, 128, 2048},
		{"thumbnailQuality", in.ThumbnailQuality, 40, 100},
		{"enrichTimeoutMs", in.EnrichTimeoutMS, 5000, 60000},
		{"imageUrlTtlHours", in.ImageURLTTLHours, 1, 720},
	}
	for _, r := range ranges {
		if r.value < r.min || r.value > r.max {
			return Settings{}, settingError(r.field, fmt.Sprintf("%s must be an integer between %d and %d", r.field, r.min, r.max))
		}
	}
	return out, nil
}

// normalizeServiceURL accepts https anywhere and http only for loopback hosts.
// It rejects credentials, queries, fragments and, unless allowPath is set,
// any path component other than "/".
func normalizeServiceURL(raw, field string, allowPath bool) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		if field == "imageServiceBaseUrl" {
			return "", nil
		}
		return "", settingError(field, field+" must be a non-empty string")
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return "", settingError(field, field+" must be a valid URL")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", settingError(field, field+" must use https (http is only allowed for localhost)")
	}
	if u.Scheme == "http" && !isLoopbackHost(u.Hostname()) {
		return "", settingError(field, field+" must use https (http is only allowed for localhost)")
	}
	if u.User != nil {
		return "", settingError(field, field+" must not contain credentials")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", settingError(field, field+" must not contain a query or fragment")
	}
	if !allowPath && u.Path != "" && u.Path != "/" {
		return "", settingError(field, field+" must not contain a path")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	return u.String(), nil
}

// NormalizeImageOrigin accepts an empty setting or a strict external origin.
func NormalizeImageOrigin(raw string) (string, error) {
	return normalizeExternalOrigin(raw, "imagePublicBaseUrl")
}

// NormalizePublicOrigin accepts an empty value or the PUBLIC_ORIGIN env.
func NormalizePublicOrigin(raw string) (string, error) {
	return normalizeExternalOrigin(raw, "PUBLIC_ORIGIN")
}

func normalizeExternalOrigin(raw, field string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.Opaque != "" || u.User != nil || strings.ContainsAny(value, "?#\\\\") || u.ForceQuery || (u.Path != "" && u.Path != "/") || u.RawPath != "" {
		return "", settingError(field, field+" must be an origin without credentials, path, query or fragment")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !isLoopbackHost(u.Hostname())) {
		return "", settingError(field, field+" must use https (http is only allowed for localhost)")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || strings.ContainsAny(host, " \t\r\n/%") {
		return "", settingError(field, field+" must have a valid host")
	}
	if strings.Contains(host, ":") && net.ParseIP(host) == nil {
		return "", settingError(field, field+" must have a valid host")
	}
	port := u.Port()
	if strings.HasSuffix(u.Host, ":") {
		return "", settingError(field, field+" must have a valid port")
	}
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", settingError(field, field+" must have a valid port")
		}
		port = strconv.Itoa(n)
		if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
			port = ""
		}
	}
	if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	}
	u.Path = ""
	return u.String(), nil
}

func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}
