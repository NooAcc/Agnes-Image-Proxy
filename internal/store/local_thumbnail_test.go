package store

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func thumbnailFixture(t *testing.T) (*Store, string, domain.StoredImage, []byte) {
	t.Helper()
	s, dir := localGallery(t)
	saved, err := s.SaveGeneratedImage(context.Background(), localInsert("thumb"))
	if err != nil {
		t.Fatal(err)
	}
	data := testutil.PNG(t, 2, 3)
	if err := s.SetEnrichment(context.Background(), saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: data, ThumbMIME: "image/png"}); err != nil {
		t.Fatal(err)
	}
	return s, dir, saved, data
}
func thumbnailPath(t *testing.T, s *Store, id int64) string {
	t.Helper()
	var p string
	if err := s.db.QueryRow("SELECT thumb_path FROM gallery WHERE id=?", id).Scan(&p); err != nil {
		t.Fatal(err)
	}
	return p
}
func TestLocalThumbnailRestoreWriteFailsStillReturnsBackup(t *testing.T) {
	faults := &localFaults{}
	s, dir := faultGallery(t, faults)
	ctx := context.Background()
	saved, err := s.SaveGeneratedImage(ctx, localInsert("restore-fault"))
	if err != nil {
		t.Fatal(err)
	}
	data := testutil.PNG(t, 2, 3)
	if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: data, ThumbMIME: "image/png"}); err != nil {
		t.Fatal(err)
	}
	if err := s.files.remove(thumbnailPath(t, s, saved.ID)); err != nil {
		t.Fatal(err)
	}
	// Once missing read selects backup, block creation of its version directory.
	faults.before = func(q string) {
		if strings.Contains(q, "SELECT thumb FROM") {
			picture := filepath.Join(dir, "images", saved.PublicID[:2], saved.PublicID)
			if err := os.RemoveAll(picture); err != nil {
				t.Error(err)
				return
			}
			if err := os.WriteFile(picture, []byte("blocked"), 0600); err != nil {
				t.Error(err)
			}
		}
	}
	got, mime, err := s.GalleryContent(ctx, saved.ID, true)
	if err != nil || mime != "image/png" || !bytes.Equal(got, data) {
		t.Fatal("restore failure hid valid backup", err)
	}
}

func TestLocalThumbnailCommittedUpdateErrorKeepsNewVersion(t *testing.T) {
	var fail atomic.Bool
	faults := &localFaults{afterExec: func(q string) error {
		if strings.Contains(q, "thumb_path = ?") && fail.Swap(false) {
			return errors.New("lost update response")
		}
		return nil
	}}
	s, dir := faultGallery(t, faults)
	ctx := context.Background()
	saved, err := s.SaveGeneratedImage(ctx, localInsert("update-ambiguous"))
	if err != nil {
		t.Fatal(err)
	}
	first := testutil.PNG(t, 2, 3)
	if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: first, ThumbMIME: "image/png"}); err != nil {
		t.Fatal(err)
	}
	old := thumbnailPath(t, s, saved.ID)
	next := testutil.WebP(4, 5)
	fail.Store(true)
	if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: next, ThumbMIME: "image/webp"}); err == nil {
		t.Fatal("response error hidden")
	}
	if old == thumbnailPath(t, s, saved.ID) {
		t.Fatal("update did not commit")
	}
	got, mime, err := s.GalleryContent(ctx, saved.ID, true)
	if err != nil || mime != "image/webp" || !bytes.Equal(got, next) {
		t.Fatal("committed version lost", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "images", filepath.FromSlash(old))); err != nil {
		t.Fatal("possibly referenced old version removed", err)
	}
}

func TestLocalThumbnailDeleteDuringEnrichmentOrRestore(t *testing.T) {
	for _, operation := range []string{"enrichment", "restore"} {
		for _, cleanup := range []string{"delete", "clear"} {
			t.Run(operation+"/"+cleanup, func(t *testing.T) {
				faults := &localFaults{}
				s, dir := faultGallery(t, faults)
				ctx := context.Background()
				saved, err := s.SaveGeneratedImage(ctx, localInsert("interleave"))
				if err != nil {
					t.Fatal(err)
				}
				data := testutil.PNG(t, 2, 3)
				if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: data, ThumbMIME: "image/png"}); err != nil {
					t.Fatal(err)
				}
				if operation == "restore" {
					if err := s.files.remove(thumbnailPath(t, s, saved.ID)); err != nil {
						t.Fatal(err)
					}
				}
				entered, release := make(chan struct{}), make(chan struct{})
				var once atomic.Bool
				faults.before = func(q string) {
					match := operation == "enrichment" && strings.HasPrefix(q, "UPDATE gallery SET enrich_status") || operation == "restore" && strings.Contains(q, "SELECT thumb FROM")
					if match && once.CompareAndSwap(false, true) {
						close(entered)
						<-release
					}
				}
				workDone, cleanDone := make(chan error, 1), make(chan error, 1)
				go func() {
					if operation == "enrichment" {
						workDone <- s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: testutil.WebP(4, 5), ThumbMIME: "image/webp"})
					} else {
						_, _, err := s.GalleryContent(ctx, saved.ID, true)
						workDone <- err
					}
				}()
				<-entered
				go func() {
					if cleanup == "clear" {
						cleanDone <- s.ClearGallery(ctx)
					} else {
						_, err := s.DeleteGallery(ctx, saved.ID)
						cleanDone <- err
					}
				}()
				select {
				case err := <-cleanDone:
					t.Fatal("cleanup bypassed active operation", err)
				default:
				}
				close(release)
				if err := <-workDone; err != nil {
					t.Fatal(err)
				}
				if err := <-cleanDone; err != nil {
					t.Fatal(err)
				}
				if _, _, err := s.GalleryContent(ctx, saved.ID, true); err == nil {
					t.Fatal("deleted row revived")
				}
				if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: data, ThumbMIME: "image/png"}); err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(filepath.Join(dir, "images", saved.PublicID[:2], saved.PublicID)); !os.IsNotExist(err) {
					t.Fatal("deleted picture files revived", err)
				}
			})
		}
	}
}

func TestLocalThumbnailWritesFileAndBackup(t *testing.T) {
	s, _, saved, data := thumbnailFixture(t)
	path := thumbnailPath(t, s, saved.ID)
	got, err := s.files.read(context.Background(), path)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("thumbnail not on disk", err)
	}
	var backup []byte
	var mime string
	var size int64
	if err := s.db.QueryRow("SELECT thumb,thumb_mime,thumb_bytes FROM gallery WHERE id=?", saved.ID).Scan(&backup, &mime, &size); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(backup, data) || mime != "image/png" || size != int64(len(data)) {
		t.Fatal("backup metadata mismatch")
	}
}
func TestLocalThumbnailReadDoesNotSelectBackup(t *testing.T) {
	s, _, saved, data := thumbnailFixture(t)
	if _, err := s.db.Exec("UPDATE gallery SET thumb=? WHERE id=?", []byte("corrupt backup"), saved.ID); err != nil {
		t.Fatal(err)
	}
	got, mime, err := s.GalleryContent(context.Background(), saved.ID, true)
	if err != nil || mime != "image/png" || !bytes.Equal(got, data) {
		t.Fatal("normal read selected backup", err)
	}
}
func TestLocalThumbnailMissingRestoresBackup(t *testing.T) {
	s, _, saved, data := thumbnailFixture(t)
	if err := s.files.remove(thumbnailPath(t, s, saved.ID)); err != nil {
		t.Fatal(err)
	}
	got, mime, err := s.GalleryContent(context.Background(), saved.ID, true)
	if err != nil || mime != "image/png" || !bytes.Equal(got, data) {
		t.Fatal("backup not returned", err)
	}
	restored, err := s.files.read(context.Background(), thumbnailPath(t, s, saved.ID))
	if err != nil || !bytes.Equal(restored, data) {
		t.Fatal("not restored", err)
	}
	if _, err := s.db.Exec("UPDATE gallery SET thumb=NULL WHERE id=?", saved.ID); err != nil {
		t.Fatal(err)
	}
	got, _, err = s.GalleryContent(context.Background(), saved.ID, true)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("second read depends on backup", err)
	}
}
func TestLocalThumbnailNonMissingReadError(t *testing.T) {
	s, dir, saved, _ := thumbnailFixture(t)
	path := thumbnailPath(t, s, saved.ID)
	if err := s.files.remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "images", filepath.FromSlash(path)), 0750); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.GalleryContent(context.Background(), saved.ID, true); err == nil {
		t.Fatal("nonmissing directory read error hidden by backup")
	}
}
func TestLocalThumbnailVersionMatchesMIME(t *testing.T) {
	s, _, saved, _ := thumbnailFixture(t)
	ctx := context.Background()
	versions := []struct {
		mime string
		data []byte
	}{{"image/png", testutil.PNG(t, 2, 3)}, {"image/webp", testutil.WebP(4, 5)}}
	var wg sync.WaitGroup
	for _, version := range versions {
		wg.Go(func() {
			for i := 0; i < 15; i++ {
				if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: version.data, ThumbMIME: version.mime}); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	for i := 0; i < 3; i++ {
		wg.Go(func() {
			for j := 0; j < 30; j++ {
				data, mime, err := s.GalleryContent(ctx, saved.ID, true)
				if err != nil || images.SniffImage(data) != mime {
					t.Errorf("mixed thumbnail version %q %v", mime, err)
					return
				}
			}
		})
	}
	wg.Wait()
	var backup []byte
	var mime string
	var size int64
	if err := s.db.QueryRow("SELECT thumb,thumb_mime,thumb_bytes FROM gallery WHERE id=?", saved.ID).Scan(&backup, &mime, &size); err != nil {
		t.Fatal(err)
	}
	local, err := s.files.read(ctx, thumbnailPath(t, s, saved.ID))
	if err != nil || !bytes.Equal(local, backup) || images.SniffImage(local) != mime || int64(len(local)) != size {
		t.Fatal("final version mismatch", err)
	}
}
func TestLocalThumbnailMissingIDNoFilesAndFailureKeepsThumbnail(t *testing.T) {
	s, dir, saved, data := thumbnailFixture(t)
	ctx := context.Background()
	if err := s.SetEnrichment(ctx, 999, domain.EnrichmentWrite{Status: "success", Thumb: data, ThumbMIME: "image/png"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "failed"}); err != nil {
		t.Fatal(err)
	}
	got, _, err := s.GalleryContent(ctx, saved.ID, true)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("failure erased thumbnail", err)
	}
	count := 0
	if err := filepath.WalkDir(filepath.Join(dir, "images"), func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			count++
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatal("missing ID wrote files", count)
	}
}
func TestLocalThumbnailFailedUpdateKeepsPriorVersion(t *testing.T) {
	s, dir, saved, data := thumbnailFixture(t)
	ctx := context.Background()
	oldPath := thumbnailPath(t, s, saved.ID)
	if _, err := s.db.Exec(`CREATE TRIGGER fail_enrichment BEFORE UPDATE ON gallery BEGIN SELECT RAISE(ABORT, 'fail'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: testutil.WebP(4, 5), ThumbMIME: "image/webp"}); err == nil {
		t.Fatal("SQL error hidden")
	}
	if path := thumbnailPath(t, s, saved.ID); path != oldPath {
		t.Fatal("failed update moved pointer")
	}
	got, mime, err := s.GalleryContent(ctx, saved.ID, true)
	if err != nil || mime != "image/png" || !bytes.Equal(got, data) {
		t.Fatal("failed update erased prior version", err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "images", saved.PublicID[:2], saved.PublicID))
	if err != nil || len(entries) != 3 {
		t.Fatal("uncertain candidate not retained", len(entries), err)
	}
}
