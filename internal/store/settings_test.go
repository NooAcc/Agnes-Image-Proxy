package store_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
)

func TestSettingsReadWrite(t *testing.T) {
	s, _ := newSchemaStore(t)
	ctx := context.Background()

	got, err := s.ReadSettings(ctx)
	if err != nil {
		t.Fatalf("read defaults: %v", err)
	}
	if got.DefaultSize != "1K" || got.MaxAttempts != 3 {
		t.Fatalf("unexpected defaults: %+v", got)
	}

	next := got
	next.DefaultSize = "2K"
	next.MaxAttempts = 5
	next.ImageServiceBaseURL = "https://images.example.com"
	if err := s.WriteSettings(ctx, next); err != nil {
		t.Fatalf("write: %v", err)
	}
	read, err := s.ReadSettings(ctx)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if read.DefaultSize != "2K" || read.MaxAttempts != 5 || read.ImageServiceBaseURL != "https://images.example.com" {
		t.Fatalf("settings not persisted: %+v", read)
	}
}

func TestWriteSettingsRejectsInvalidWithoutMutation(t *testing.T) {
	s, _ := newSchemaStore(t)
	ctx := context.Background()
	next := domain.DefaultSettings()
	next.ThumbnailWidth = 10
	if err := s.WriteSettings(ctx, next); err == nil {
		t.Fatal("invalid settings accepted")
	}
	read, err := s.ReadSettings(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if read.ThumbnailWidth != 640 {
		t.Fatalf("invalid write mutated settings: %+v", read)
	}
}

func TestReadSettingsRejectsUnknownField(t *testing.T) {
	s, db := newSchemaStore(t)
	ctx := context.Background()

	raw, err := json.Marshal(domain.DefaultSettings())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	obj["legacyDefaultResponseFormat"] = json.RawMessage(`"b64_json"`)
	corrupt, _ := json.Marshal(obj)
	if _, err := db.Exec("UPDATE settings SET data=? WHERE id=1", string(corrupt)); err != nil {
		t.Fatalf("corrupt settings: %v", err)
	}
	if _, err := s.ReadSettings(ctx); err == nil {
		t.Fatal("unknown settings field must be rejected")
	}
}

func TestReadSettingsMissingRow(t *testing.T) {
	s, db := newSchemaStore(t)
	if _, err := db.Exec("DELETE FROM settings"); err != nil {
		t.Fatalf("delete settings: %v", err)
	}
	if _, err := s.ReadSettings(context.Background()); err == nil {
		t.Fatal("missing settings row must be an error")
	}
}

// Ensure the store type is constructible exactly as the plan specifies.
var _ = store.New
