package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func TestDatabaseOperationsHaveOwnDeadline(t *testing.T) {
	db := testutil.OpenDB(t)
	s, err := New(db, NewOptions{Now: time.Now, DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	held, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	s.timeout = 5 * time.Millisecond
	calls := []struct {
		name string
		run  func(context.Context) error
	}{
		{"settings read", func(ctx context.Context) error { _, e := s.ReadSettings(ctx); return e }},
		{"account claim", func(ctx context.Context) error { _, e := s.Claim(ctx, nil); return e }},
		{"gallery write", func(ctx context.Context) error {
			_, e := s.InsertGallery(ctx, domain.GalleryInsert{OutputKey: "deadline:0:0"})
			return e
		}},
		{"log transaction", func(ctx context.Context) error {
			return s.RecordRequest(ctx, domain.RequestLog{Model: "m", Requested: 1})
		}},
	}
	for _, call := range calls {
		t.Run(call.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
			defer cancel()
			started := time.Now()
			err := call.run(ctx)
			if elapsed := time.Since(started); elapsed >= 25*time.Millisecond {
				t.Fatalf("operation used caller deadline instead of own budget: %v", elapsed)
			}
			var ae *apierror.Error
			if !errors.As(err, &ae) || ae.Status != 503 {
				t.Fatalf("database timeout must be generic 503, got %v", err)
			}
		})
	}
}

func TestEnrichmentStateContainsOnlyMetadata(t *testing.T) {
	db := testutil.OpenDB(t)
	s, err := New(db, NewOptions{Now: time.Now, DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		t.Fatal(err)
	}
	mime := "image/png"
	url := "https://expired.example/image.png"
	data := []byte{0, 1, 2, 255}
	id, err := s.InsertGallery(ctx, domain.GalleryInsert{OutputKey: "recovery:0:0", Image: data, ImageMIME: &mime, SourceURL: &url})
	if err != nil {
		t.Fatal(err)
	}
	_, source, found, err := s.GalleryEnrichState(ctx, id)
	if err != nil || !found || source.Bytes != int64(len(data)) {
		t.Fatalf("stored original unavailable to backfill: %+v %v", source, err)
	}
}

func TestLogKeepsSubrequestFailuresIndependentOfImages(t *testing.T) {
	db := testutil.OpenDB(t)
	s, err := New(db, NewOptions{Now: time.Now, DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordRequest(ctx, domain.RequestLog{Model: "m", Requested: 3, Images: 2, Failed: 2, Stage: "complete", Status: 200}); err != nil {
		t.Fatal(err)
	}
	logs, err := s.ListLogs(ctx, domain.CursorQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if logs.Items[0].Failed != 2 {
		t.Fatalf("failed subrequests = %d; expected 2, not requested minus images", logs.Items[0].Failed)
	}
}
