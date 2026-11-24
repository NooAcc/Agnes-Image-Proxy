package domain

import (
	"encoding/json"
	"testing"
)

func TestImageLinkSettings(t *testing.T) {
	s := DefaultSettings()
	if s.ImageURLTTLHours != 24 || s.ImagePublicBaseURL != "" {
		t.Fatalf("defaults: %+v", s)
	}
	for _, hours := range []int{-1, 0, 1, 24, 720, 721} {
		s.ImageURLTTLHours = hours
		_, err := ValidateSettings(s)
		if (err == nil) != (hours >= 1 && hours <= 720) {
			t.Errorf("hours %d: %v", hours, err)
		}
	}
	s = DefaultSettings()
	for _, tc := range []struct {
		origin string
		valid  bool
	}{
		{"", true}, {"https://images.example.com", true}, {"https://images.example.com/", true},
		{"http://localhost:8080", true}, {"http://127.0.0.1:8080", true}, {"http://[::1]:8080", true},
		{"https://images.example.com/path", false}, {"https://images.example.com?q=x", false},
		{"https://images.example.com?", false}, {"https://images.example.com#", false},
		{"https://user@images.example.com", false}, {"http://images.example.com", false},
		{"https://images.example.com:99999", false}, {"https://images.example.com:", false},
	} {
		s.ImagePublicBaseURL = tc.origin
		got, err := ValidateSettings(s)
		if (err == nil) != tc.valid {
			t.Errorf("origin %q: %v", tc.origin, err)
		}
		if tc.origin == "https://images.example.com/" && got.ImagePublicBaseURL != "https://images.example.com" {
			t.Errorf("not normalized: %q", got.ImagePublicBaseURL)
		}
	}
}

func TestImageLinkSettingsJSON(t *testing.T) {
	raw, _ := json.Marshal(DefaultSettings())
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	for _, key := range []string{"imageUrlTtlHours", "imagePublicBaseUrl"} {
		original := fields[key]
		delete(fields, key)
		missing, _ := json.Marshal(fields)
		var s Settings
		if json.Unmarshal(missing, &s) == nil {
			t.Errorf("missing %s accepted", key)
		}
		fields[key] = original
	}
	for _, value := range []string{`1.5`, `"24"`, `null`} {
		fields["imageUrlTtlHours"] = json.RawMessage(value)
		invalid, _ := json.Marshal(fields)
		var s Settings
		if json.Unmarshal(invalid, &s) == nil {
			t.Errorf("TTL %s accepted", value)
		}
	}
	fields["imageUrlTtlHours"] = json.RawMessage(`24`)
	fields["imagePublicBaseUrl"] = json.RawMessage(`null`)
	invalid, _ := json.Marshal(fields)
	var s Settings
	if json.Unmarshal(invalid, &s) == nil {
		t.Error("null origin accepted")
	}
}
