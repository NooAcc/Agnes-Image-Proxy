package httpapi_test

import (
	"encoding/json"
	"os"
	"sort"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

type importResponse struct {
	Imported int `json:"imported"`
	Errors   []struct {
		Index   int    `json:"index"`
		Message string `json:"message"`
	} `json:"errors"`
}

type probeListResponse struct {
	Items []service.ProbeResult `json:"items"`
}

type accountListResponse struct {
	Items []domain.AccountSummary `json:"items"`
}

type sessionResponse struct {
	Authenticated bool `json:"authenticated"`
}

// TestAdminContractFixture keeps the generated admin contract fixture in sync
// with the Go DTOs that Task 12's Zod schemas validate against.
func TestAdminContractFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/admin-contracts.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("fixture JSON: %v", err)
	}

	samples := map[string]any{
		"session":              sessionResponse{},
		"accountSummary":       domain.AccountSummary{},
		"accountList":          accountListResponse{},
		"importResponse":       importResponse{},
		"probeResult":          service.ProbeResult{},
		"probeList":            probeListResponse{},
		"settings":             domain.DefaultSettings(),
		"requestLog":           domain.RequestLog{},
		"logPage":              domain.Page[domain.RequestLog]{},
		"overview":             domain.Overview{},
		"galleryItem":          domain.GalleryItem{},
		"galleryPage":          domain.Page[domain.GalleryItem]{},
		"backfillStatus":       service.BackfillStatus{},
		"storageUninitialized": domain.StorageStatus{},
		"storageLocal":         domain.StorageConfig{Mode: domain.StorageLocal}.Status(),
		"storageImgbed": domain.StorageConfig{
			Mode: domain.StorageImgbed, ImgbedBaseURL: "https://img.example.com", ImgbedToken: "token",
		}.Status(),
	}
	for name, sample := range samples {
		entry, ok := fixture[name]
		if !ok {
			t.Fatalf("fixture is missing %q", name)
		}
		fixtureKeys, err := objectKeys(entry)
		if err != nil {
			t.Fatalf("%s fixture: %v", name, err)
		}
		encoded, err := json.Marshal(sample)
		if err != nil {
			t.Fatalf("%s sample: %v", name, err)
		}
		sampleKeys, err := objectKeys(encoded)
		if err != nil {
			t.Fatalf("%s sample keys: %v", name, err)
		}
		if !equalKeys(fixtureKeys, sampleKeys) {
			t.Fatalf("%s keys = %v, DTO keys = %v", name, fixtureKeys, sampleKeys)
		}
	}
}

func objectKeys(raw json.RawMessage) ([]string, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys, nil
}

func equalKeys(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
