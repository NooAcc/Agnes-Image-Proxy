package store_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

func originalPNG(t *testing.T) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func generatedInsert(t *testing.T, key string) domain.GalleryInsert {
	return domain.GalleryInsert{OutputKey: key, RequestID: "request", Model: "m", Prompt: "p", SizeRequest: "1K", Image: originalPNG(t), ImageMIME: ptr("image/png")}
}
func TestPublicInfoDoesNotSelectBlob(t *testing.T) {
	// A metadata-only SQL boundary: selecting image would fail because the column
	// does not exist. This verifies both public and numeric HEAD queries.
	db := testutil.OpenDB(t)
	_, err := db.Exec(`CREATE TABLE gallery (id INTEGER PRIMARY KEY, public_id TEXT, image_mime TEXT, image_bytes INTEGER, image_path TEXT);
		INSERT INTO gallery VALUES (1, '0123456789abcdef0123456789abcdef', 'image/png', 68, '01/0123456789abcdef0123456789abcdef/original.png')`)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	pictureDir := filepath.Join(dir, "images", "01", "0123456789abcdef0123456789abcdef")
	if err := os.MkdirAll(pictureDir, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pictureDir, "original.png"), make([]byte, 68), 0640); err != nil {
		t.Fatal(err)
	}
	s, constructErr := store.New(db, nil, dir)
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	for _, read := range []func() (domain.StoredImage, error){
		func() (domain.StoredImage, error) { return s.ImageInfo(context.Background(), 1) },
		func() (domain.StoredImage, error) {
			return s.PublicImageInfo(context.Background(), "0123456789abcdef0123456789abcdef")
		},
	} {
		info, err := read()
		if err != nil || info.Bytes != 68 || info.MIME != "image/png" {
			t.Fatalf("metadata-only read: %+v %v", info, err)
		}
	}
}

func TestPublicImageIdentity(t *testing.T) {
	s, _ := newSchemaStore(t)
	ctx := context.Background()
	in := generatedInsert(t, "request:0:0")
	saved, err := s.SaveGeneratedImage(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hex.DecodeString(saved.PublicID); err != nil || len(saved.PublicID) != 32 {
		t.Fatalf("public ID: %+v", saved)
	}
	if saved.ID <= 0 || saved.MIME != "image/png" || saved.Bytes != int64(len(in.Image)) {
		t.Fatalf("metadata: %+v", saved)
	}
	info, err := s.PublicImageInfo(ctx, saved.PublicID)
	if err != nil || info != saved {
		t.Fatalf("info: %+v %v", info, err)
	}
	info, err = s.ImageInfo(ctx, saved.ID)
	if err != nil || info != saved {
		t.Fatalf("numeric info: %+v %v", info, err)
	}
	data, mime, err := s.PublicImageContent(ctx, saved.PublicID)
	if err != nil || mime != "image/png" || !bytes.Equal(data, in.Image) {
		t.Fatalf("content: %q %v", mime, err)
	}
}
func TestSaveGeneratedImageIdempotent(t *testing.T) {
	s, db := newSchemaStore(t)
	ctx := context.Background()
	in := generatedInsert(t, "request:0:0")
	first, err := s.SaveGeneratedImage(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	in.Image = append(in.Image, 1)
	second, err := s.SaveGeneratedImage(ctx, in)
	if err != nil || first != second {
		t.Fatalf("retry: %+v %+v %v", first, second, err)
	}
	data, _, err := s.PublicImageContent(ctx, first.PublicID)
	if err != nil || !bytes.Equal(data, originalPNG(t)) {
		t.Fatal("retry overwrote original", err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM gallery").Scan(&count); err != nil || count != 1 {
		t.Fatalf("rows: %d %v", count, err)
	}
}
func TestSaveGeneratedImageConcurrent(t *testing.T) {
	s, db := newSchemaStore(t)
	in := generatedInsert(t, "request:0:0")
	var wg sync.WaitGroup
	results := make(chan domain.StoredImage, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Go(func() { image, err := s.SaveGeneratedImage(context.Background(), in); results <- image; errs <- err })
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first domain.StoredImage
	for image := range results {
		if first.ID == 0 {
			first = image
		}
		if image != first {
			t.Fatalf("duplicate: %+v %+v", first, image)
		}
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM gallery").Scan(&count); err != nil || count != 1 {
		t.Fatalf("rows: %d %v", count, err)
	}
}
func TestPublicIDAfterClearAndNumericIDReuse(t *testing.T) {
	s, db := newSchemaStore(t)
	ctx := context.Background()
	old, err := s.SaveGeneratedImage(ctx, generatedInsert(t, "request:0:0"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ClearGallery(ctx); err != nil {
		t.Fatal(err)
	}
	// Simulate numeric ID reuse, even with SQLite's AUTOINCREMENT baseline.
	if _, err := db.Exec("DELETE FROM sqlite_sequence WHERE name='gallery'"); err != nil {
		t.Fatal(err)
	}
	next, err := s.SaveGeneratedImage(ctx, generatedInsert(t, "next:0:0"))
	if err != nil {
		t.Fatal(err)
	}
	if old.ID != next.ID || old.PublicID == next.PublicID {
		t.Fatalf("identity reuse: %+v %+v", old, next)
	}
	if _, err := s.PublicImageInfo(ctx, old.PublicID); err == nil {
		t.Fatal("deleted public ID still available")
	}
}
func TestSaveGeneratedImageRejectsInvalid(t *testing.T) {
	s, db := newSchemaStore(t)
	for _, mutate := range []func(*domain.GalleryInsert){func(in *domain.GalleryInsert) { in.OutputKey = "" }, func(in *domain.GalleryInsert) { in.Image = nil }, func(in *domain.GalleryInsert) { in.ImageMIME = ptr("image/gif") }} {
		in := generatedInsert(t, "request:0:0")
		mutate(&in)
		if _, err := s.SaveGeneratedImage(context.Background(), in); err == nil {
			t.Fatal("invalid generated image accepted")
		}
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM gallery").Scan(&count); err != nil || count != 0 {
		t.Fatalf("rows: %d %v", count, err)
	}
}
func TestDeliveryLogRoundTripAndPartialUsage(t *testing.T) {
	s, _ := newSchemaStore(t)
	ctx := context.Background()
	log := domain.RequestLog{RequestID: "req", Category: "request", Stage: "complete", Model: "m", Status: 200, Requested: 1, Images: 2, Partial: true, DeliveryFailures: []domain.DeliveryFailure{{SubrequestIndex: 0, ImageIndex: 1, Stage: "persist", Status: 503, Code: "image_persist_failed"}}}
	if err := s.RecordRequest(ctx, log); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListLogs(ctx, domain.CursorQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || !page.Items[0].Partial || page.Items[0].Failed != 0 || len(page.Items[0].DeliveryFailures) != 1 || page.Items[0].DeliveryFailures[0] != log.DeliveryFailures[0] {
		t.Fatalf("logs: %+v", page)
	}
	overview, err := s.Overview(ctx, "2026-11-24", "2026-11-24")
	if err != nil {
		t.Fatal(err)
	}
	if overview.Totals.Partials != 1 || overview.Totals.Images != 2 {
		t.Fatalf("usage: %+v", overview.Totals)
	}
	log.Partial = false
	log.DeliveryFailures = nil
	if err := s.RecordRequest(ctx, log); err != nil {
		t.Fatal(err)
	}
	page, err = s.ListLogs(ctx, domain.CursorQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if page.Items[0].Partial || page.Items[0].DeliveryFailures == nil {
		t.Fatalf("empty DTO: %+v", page.Items[0])
	}
}
