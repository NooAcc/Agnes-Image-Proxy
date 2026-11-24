package domain_test

import (
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

func validSettings() domain.Settings {
	return domain.DefaultSettings()
}

func TestValidateSettingsAcceptsDefaults(t *testing.T) {
	got, err := domain.ValidateSettings(validSettings())
	if err != nil {
		t.Fatalf("defaults rejected: %v", err)
	}
	if got.DefaultSize != "1K" || got.ImageParamMode != "nested" {
		t.Fatalf("unexpected normalized settings: %+v", got)
	}
}

func TestValidateSettingsRanges(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*domain.Settings)
	}{
		{"probeConcurrency zero", func(s *domain.Settings) { s.ProbeConcurrency = 0 }},
		{"probeConcurrency high", func(s *domain.Settings) { s.ProbeConcurrency = 11 }},
		{"refresh low", func(s *domain.Settings) { s.AutoRefreshIntervalMS = 1999 }},
		{"refresh high", func(s *domain.Settings) { s.AutoRefreshIntervalMS = 60001 }},
		{"maxAttempts zero", func(s *domain.Settings) { s.MaxAttempts = 0 }},
		{"maxAttempts high", func(s *domain.Settings) { s.MaxAttempts = 11 }},
		{"timeout low", func(s *domain.Settings) { s.RequestTimeoutMS = 59999 }},
		{"timeout high", func(s *domain.Settings) { s.RequestTimeoutMS = 360001 }},
		{"thumb width low", func(s *domain.Settings) { s.ThumbnailWidth = 127 }},
		{"thumb width high", func(s *domain.Settings) { s.ThumbnailWidth = 2049 }},
		{"thumb quality low", func(s *domain.Settings) { s.ThumbnailQuality = 39 }},
		{"thumb quality high", func(s *domain.Settings) { s.ThumbnailQuality = 101 }},
		{"enrich timeout low", func(s *domain.Settings) { s.EnrichTimeoutMS = 4999 }},
		{"enrich timeout high", func(s *domain.Settings) { s.EnrichTimeoutMS = 60001 }},
		{"empty agnes url", func(s *domain.Settings) { s.AgnesBaseURL = "  " }},
		{"bad size", func(s *domain.Settings) { s.DefaultSize = "8K" }},
		{"bad param mode", func(s *domain.Settings) { s.ImageParamMode = "query" }},
		{"empty probe model", func(s *domain.Settings) { s.ProbeModel = " " }},
		{"http remote agnes url", func(s *domain.Settings) { s.AgnesBaseURL = "http://agnes.example.com/v1" }},
		{"http remote image service", func(s *domain.Settings) { s.ImageServiceBaseURL = "http://images.example.com" }},
		{"agnes url with userinfo", func(s *domain.Settings) { s.AgnesBaseURL = "https://user:pass@example.com/v1" }},
		{"agnes url with query", func(s *domain.Settings) { s.AgnesBaseURL = "https://example.com/v1?x=1" }},
		{"agnes url with hash", func(s *domain.Settings) { s.AgnesBaseURL = "https://example.com/v1#frag" }},
		{"image service url with path", func(s *domain.Settings) { s.ImageServiceBaseURL = "https://example.com/api" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := validSettings()
			tc.mutate(&s)
			if _, err := domain.ValidateSettings(s); err == nil {
				t.Fatalf("expected %s to be rejected", tc.name)
			}
		})
	}
}

func TestValidateSettingsNormalizes(t *testing.T) {
	s := validSettings()
	s.AgnesBaseURL = "https://example.com/v1///"
	s.DefaultSize = "2k"
	s.ImageServiceBaseURL = "http://localhost:9000/"
	s.ProbeModel = "  model-a  "

	got, err := domain.ValidateSettings(s)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.AgnesBaseURL != "https://example.com/v1" {
		t.Fatalf("agnes url not normalized: %q", got.AgnesBaseURL)
	}
	if got.DefaultSize != "2K" {
		t.Fatalf("size not uppercased: %q", got.DefaultSize)
	}
	if got.ImageServiceBaseURL != "http://localhost:9000" {
		t.Fatalf("image service not normalized: %q", got.ImageServiceBaseURL)
	}
	if got.ProbeModel != "model-a" {
		t.Fatalf("probe model not trimmed: %q", got.ProbeModel)
	}
}

func TestValidateSettingsAllowsEmptyImageService(t *testing.T) {
	s := validSettings()
	s.ImageServiceBaseURL = "   "
	got, err := domain.ValidateSettings(s)
	if err != nil {
		t.Fatalf("empty image service should be allowed: %v", err)
	}
	if got.ImageServiceBaseURL != "" {
		t.Fatalf("expected empty image service, got %q", got.ImageServiceBaseURL)
	}
}
