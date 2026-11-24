package domain

import "testing"

func TestSettingsDefaults(t *testing.T) {
	s := DefaultSettings()
	if s.DefaultSize != "1K" || s.MaxAttempts != 3 || s.RequestTimeoutMS != 300000 || s.ThumbnailWidth != 640 || s.ThumbnailQuality != 75 || s.EnrichTimeoutMS != 60000 {
		t.Fatalf("wrong defaults: %+v", s)
	}
	if s.AgnesBaseURL != "https://apihub.agnes-ai.com/v1" || s.ImageParamMode != "nested" || s.ProbeModel != "agnes-image-2.5-flash" {
		t.Fatalf("wrong defaults: %+v", s)
	}
	if s.ProbeConcurrency != 2 || s.AutoRefreshIntervalMS != 5000 || s.ImageServiceBaseURL != "" {
		t.Fatalf("wrong defaults: %+v", s)
	}
}
