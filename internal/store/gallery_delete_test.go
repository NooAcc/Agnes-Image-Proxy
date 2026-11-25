package store

import (
	"context"
	"database/sql/driver"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func saveImgbedImage(t *testing.T, s *Store, key string) domain.StoredImage {
	t.Helper()
	saved, _, err := s.SaveDeliveryImage(context.Background(), pngInsert(t, key), false)
	if err != nil {
		t.Fatalf("save %s: %v", key, err)
	}
	return saved
}

func galleryRef(t *testing.T, s *Store, id int64) string {
	t.Helper()
	var ref string
	if err := s.db.QueryRow(`SELECT original_ref FROM gallery WHERE id = ?`, id).Scan(&ref); err != nil {
		t.Fatalf("ref for %d: %v", id, err)
	}
	return ref
}

func galleryCount(t *testing.T, s *Store) int {
	t.Helper()
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM gallery`).Scan(&count); err != nil {
		t.Fatalf("gallery count: %v", err)
	}
	return count
}

func assertSingleFileDeletes(t *testing.T, fake *fakeImgbed) {
	t.Helper()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.deletePath) == 0 {
		t.Fatal("no delete requests recorded")
	}
	for _, path := range fake.deletePath {
		if !strings.HasPrefix(path, "/api/manage/delete/agnes-image-proxy/") || strings.Contains(path, "?") {
			t.Fatalf("delete used a non-file path: %q", path)
		}
		for _, forbidden := range []string{"folder", "batch", "list", "recursive"} {
			if strings.Contains(path, forbidden) {
				t.Fatalf("delete path contains %q: %q", forbidden, path)
			}
		}
	}
}

func TestImgbedDeleteFailurePreservesRef(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2)}
	s, _ := newImgbedStore(t, fake, nil)
	ctx := context.Background()
	first := saveImgbedImage(t, s, "del:0:0")
	second := saveImgbedImage(t, s, "del:1:0")
	third := saveImgbedImage(t, s, "del:2:0")
	refBefore := galleryRef(t, s, second.ID)

	fake.mu.Lock()
	fake.deleteFailAt = 2 // the second delete call reports success:false
	fake.mu.Unlock()

	if ok, err := s.DeleteGallery(ctx, first.ID); err != nil || !ok {
		t.Fatalf("first delete: %v %v", ok, err)
	}
	if _, err := s.DeleteGallery(ctx, second.ID); err == nil {
		t.Fatal("logical delete failure was reported as success")
	}
	if galleryCount(t, s) != 2 {
		t.Fatal("failed delete removed rows")
	}
	if got := galleryRef(t, s, second.ID); got != refBefore {
		t.Fatalf("failed delete lost the remote locator: %q", got)
	}
	if got := galleryRef(t, s, third.ID); got == "" {
		t.Fatal("unprocessed row lost its locator")
	}
	config, found, err := s.ReadStorageConfig(ctx)
	if err != nil || !found || config.ImgbedToken != "old-token" {
		t.Fatalf("credentials changed: %+v %v", config, err)
	}

	fake.mu.Lock()
	fake.deleteFailAt = 0
	fake.deleteBody = `{"success":true,"existed":false}`
	fake.mu.Unlock()
	if ok, err := s.DeleteGallery(ctx, second.ID); err != nil || !ok {
		t.Fatalf("idempotent retry: %v %v", ok, err)
	}
	if galleryCount(t, s) != 1 {
		t.Fatal("retry did not remove the row")
	}
	assertSingleFileDeletes(t, fake)
}

func TestImgbedClearStopsAndCanRetry(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2)}
	s, dataDir := newImgbedStore(t, fake, nil)
	ctx := context.Background()
	first := saveImgbedImage(t, s, "clear:0:0")
	second := saveImgbedImage(t, s, "clear:1:0")
	third := saveImgbedImage(t, s, "clear:2:0")
	_ = first

	fake.mu.Lock()
	fake.deleteFailAt = 2
	fake.mu.Unlock()
	if err := s.ClearGallery(ctx); err == nil {
		t.Fatal("partial clear reported success")
	}
	if galleryCount(t, s) != 2 {
		t.Fatal("clear did not stop at the failed row")
	}
	if galleryRef(t, s, second.ID) == "" || galleryRef(t, s, third.ID) == "" {
		t.Fatal("failed clear lost locators")
	}
	config, found, _ := s.ReadStorageConfig(ctx)
	if !found || config.ImgbedToken != "old-token" {
		t.Fatal("partial clear lost credentials")
	}

	fake.mu.Lock()
	fake.deleteFailAt = 0
	fake.mu.Unlock()
	if err := s.ClearGallery(ctx); err != nil {
		t.Fatalf("retry clear: %v", err)
	}
	if galleryCount(t, s) != 0 {
		t.Fatal("retry clear left rows")
	}
	if _, found, err := s.ReadStorageConfig(ctx); err != nil || !found {
		t.Fatal("clear removed the fixed configuration")
	}
	entries, err := os.ReadDir(filepath.Join(dataDir, "images"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("clear left local files: %d", len(entries))
	}
	assertSingleFileDeletes(t, fake)
}

func TestImgbedResetFailurePreservesCredentials(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2)}
	s, _ := newImgbedStore(t, fake, nil)
	ctx := context.Background()
	saveImgbedImage(t, s, "reset:0:0")
	saveImgbedImage(t, s, "reset:1:0")

	fake.mu.Lock()
	fake.deleteFailAt = 1
	fake.mu.Unlock()
	if err := s.ResetSchema(ctx, true); err == nil {
		t.Fatal("reset ignored a failed remote cleanup")
	}
	config, found, err := s.ReadStorageConfig(ctx)
	if err != nil || !found || config.ImgbedToken != "old-token" || config.ImgbedBaseURL != "https://old.example.com" {
		t.Fatalf("failed reset lost credentials: %+v found=%v err=%v", config, found, err)
	}
	if galleryCount(t, s) != 2 {
		t.Fatal("failed reset lost rows")
	}

	fake.mu.Lock()
	fake.deleteFailAt = 0
	fake.mu.Unlock()
	if err := s.ResetSchema(ctx, true); err != nil {
		t.Fatalf("reset retry: %v", err)
	}
	status, err := s.StorageStatus(ctx)
	if err != nil || status.Initialized {
		t.Fatalf("schema 4 reset must return to uninitialized: %+v %v", status, err)
	}
	if galleryCount(t, s) != 0 {
		t.Fatal("reset kept rows")
	}
}

func TestResetSchema4ReturnsUninitialized(t *testing.T) {
	s, _ := localGallery(t)
	ctx := context.Background()
	if _, err := s.SaveGeneratedImage(ctx, localInsert("reset4")); err != nil {
		t.Fatal(err)
	}
	if err := s.ResetSchema(ctx, false); err == nil {
		t.Fatal("unconfirmed reset accepted")
	}
	status, err := s.StorageStatus(ctx)
	if err != nil || !status.Initialized {
		t.Fatalf("unconfirmed reset changed storage: %+v %v", status, err)
	}
	if err := s.ResetSchema(ctx, true); err != nil {
		t.Fatal(err)
	}
	status, err = s.StorageStatus(ctx)
	if err != nil || status.Initialized {
		t.Fatalf("schema 4 reset did not return to uninitialized: %+v %v", status, err)
	}
	var storageRows, galleryRows int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM storage_config`).Scan(&storageRows)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM gallery`).Scan(&galleryRows)
	if storageRows != 0 || galleryRows != 0 {
		t.Fatalf("reset left rows storage=%d gallery=%d", storageRows, galleryRows)
	}
	if _, err := s.SaveGeneratedImage(ctx, localInsert("after-reset")); err == nil {
		t.Fatal("save after reset was accepted without initialization")
	}
}

func TestDeleteRemoteSuccessDBFailureRetriesIdempotently(t *testing.T) {
	faults := &localFaults{}
	s, _ := faultGallery(t, faults)
	ctx := context.Background()
	saved, err := s.SaveGeneratedImage(ctx, localInsert("db-retry"))
	if err != nil {
		t.Fatal(err)
	}
	ref := originalPath(t, s, saved.ID)
	var once atomic.Bool
	faults.acceptDelayedExec = func(q string, _ []driver.NamedValue) bool {
		return strings.Contains(q, "DELETE FROM gallery") && once.CompareAndSwap(false, true)
	}
	if _, err := s.DeleteGallery(ctx, saved.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("DB failure = %v", err)
	}
	var keptRef string
	if err := s.db.QueryRow(`SELECT original_ref FROM gallery WHERE id = ?`, saved.ID).Scan(&keptRef); err != nil || keptRef != ref {
		t.Fatalf("row/locator lost after DB failure: %q %v", keptRef, err)
	}
	faults.acceptDelayedExec = nil
	ok, err := s.DeleteGallery(ctx, saved.ID)
	if err != nil || !ok {
		t.Fatalf("idempotent retry after remote success: %v %v", ok, err)
	}
	if galleryCount(t, s) != 0 {
		t.Fatal("retry left the row")
	}
}
