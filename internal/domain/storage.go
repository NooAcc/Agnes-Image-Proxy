package domain

import (
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

// StorageMode is the fixed original-image storage strategy chosen at first run.
type StorageMode string

const (
	StorageLocal  StorageMode = "local"
	StorageImgbed StorageMode = "imgbed"
)

// MaxImgbedTokenBytes bounds the API token accepted for ImgBed.
const MaxImgbedTokenBytes = 4096

// StorageConfig is the complete persisted storage configuration. It contains
// the ImgBed token and is for server-internal use only; it never serializes.
type StorageConfig struct {
	Mode          StorageMode `json:"-"`
	ImgbedBaseURL string      `json:"-"`
	ImgbedToken   string      `json:"-"`
}

// StorageStatus is the redacted management view. Its JSON shape is exactly one
// of the three objects in the design document.
type StorageStatus struct {
	Initialized    bool        `json:"initialized"`
	Mode           StorageMode `json:"mode,omitempty"`
	ImgbedBaseURL  string      `json:"imgbedBaseUrl,omitempty"`
	HasImgbedToken bool        `json:"hasImgbedToken,omitempty"`
}

// StorageInit is the first-run initialization request. Pointers distinguish an
// omitted field from an explicitly empty one.
type StorageInit struct {
	Mode          StorageMode `json:"mode"`
	ImgbedBaseURL *string     `json:"imgbedBaseUrl,omitempty"`
	ImgbedToken   *string     `json:"imgbedToken,omitempty"`
}

// StorageUpdate changes ImgBed connection information only. A nil or empty
// token retains the stored token.
type StorageUpdate struct {
	ImgbedBaseURL string  `json:"imgbedBaseUrl"`
	ImgbedToken   *string `json:"imgbedToken,omitempty"`
}

// Status returns the redacted management view of a valid configuration.
func (c StorageConfig) Status() StorageStatus {
	status := StorageStatus{Initialized: true, Mode: c.Mode}
	if c.Mode == StorageImgbed {
		status.ImgbedBaseURL = c.ImgbedBaseURL
		status.HasImgbedToken = c.ImgbedToken != ""
	}
	return status
}

func storageInvalid(field, message string) *apierror.Error {
	return apierror.Invalid(field, message, "invalid_value")
}

// ValidateStorageInit validates and normalizes a first-run request.
func ValidateStorageInit(in StorageInit) (StorageConfig, error) {
	switch in.Mode {
	case StorageLocal:
		if in.ImgbedBaseURL != nil || in.ImgbedToken != nil {
			return StorageConfig{}, storageInvalid("imgbedBaseUrl", "local storage does not accept imgbed fields")
		}
		return StorageConfig{Mode: StorageLocal}, nil
	case StorageImgbed:
		if in.ImgbedBaseURL == nil {
			return StorageConfig{}, storageInvalid("imgbedBaseUrl", "imgbedBaseUrl is required for imgbed storage")
		}
		if in.ImgbedToken == nil {
			return StorageConfig{}, storageInvalid("imgbedToken", "imgbedToken is required for imgbed storage")
		}
		base, err := NormalizeImgbedBaseURL(*in.ImgbedBaseURL)
		if err != nil {
			return StorageConfig{}, err
		}
		token, err := ValidateImgbedToken(*in.ImgbedToken)
		if err != nil {
			return StorageConfig{}, err
		}
		return StorageConfig{Mode: StorageImgbed, ImgbedBaseURL: base, ImgbedToken: token}, nil
	default:
		return StorageConfig{}, storageInvalid("mode", "mode must be local or imgbed")
	}
}

// ValidateStorageUpdate validates connection updates. The boolean reports
// whether the stored token must be retained.
func ValidateStorageUpdate(in StorageUpdate) (StorageConfig, bool, error) {
	base, err := NormalizeImgbedBaseURL(in.ImgbedBaseURL)
	if err != nil {
		return StorageConfig{}, false, err
	}
	if in.ImgbedToken == nil || strings.TrimSpace(*in.ImgbedToken) == "" {
		return StorageConfig{Mode: StorageImgbed, ImgbedBaseURL: base}, true, nil
	}
	token, err := ValidateImgbedToken(*in.ImgbedToken)
	if err != nil {
		return StorageConfig{}, false, err
	}
	return StorageConfig{Mode: StorageImgbed, ImgbedBaseURL: base, ImgbedToken: token}, false, nil
}

// NormalizeImgbedBaseURL accepts a public HTTPS origin, removing a trailing
// slash and normalizing the host and default port.
func NormalizeImgbedBaseURL(raw string) (string, error) {
	field := "imgbedBaseUrl"
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", storageInvalid(field, field+" must be a non-empty URL")
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return "", storageInvalid(field, field+" must be a valid URL")
	}
	if u.Scheme != "https" {
		return "", storageInvalid(field, field+" must use https")
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", storageInvalid(field, field+" must not contain credentials, query or fragment")
	}
	if u.Path != "" && u.Path != "/" || u.RawPath != "" {
		return "", storageInvalid(field, field+" must not contain a path")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || strings.ContainsAny(host, " \t\r\n/%") {
		return "", storageInvalid(field, field+" must have a valid host")
	}
	if strings.Contains(host, ":") && net.ParseIP(host) == nil {
		return "", storageInvalid(field, field+" must have a valid host")
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", storageInvalid(field, field+" must have a valid port")
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", storageInvalid(field, field+" must have a valid port")
		}
		if n == 443 {
			port = ""
		} else {
			port = strconv.Itoa(n)
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
	u.RawPath = ""
	u.RawQuery = ""
	u.ForceQuery = false
	return u.String(), nil
}

// ValidateImgbedToken trims and validates an API token. Secrets never appear
// in returned error messages.
func ValidateImgbedToken(raw string) (string, error) {
	field := "imgbedToken"
	token := strings.TrimSpace(raw)
	if token == "" {
		return "", storageInvalid(field, field+" must be a non-empty string")
	}
	if len(token) > MaxImgbedTokenBytes {
		return "", storageInvalid(field, field+" must be at most 4096 bytes")
	}
	for i := 0; i < len(token); i++ {
		if token[i] < 0x20 || token[i] == 0x7f {
			return "", storageInvalid(field, field+" must not contain control characters")
		}
	}
	return token, nil
}
