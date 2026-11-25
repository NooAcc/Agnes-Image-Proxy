package store

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func localGallery(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := New(testutil.OpenDB(t), time.Now, dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s, dir
}
func localInsert(key string) domain.GalleryInsert {
	mime := "image/png"
	return domain.GalleryInsert{OutputKey: key, Image: []byte("first original"), ImageMIME: &mime}
}
func originalPath(t *testing.T, s *Store, id int64) string {
	t.Helper()
	var p string
	if err := s.db.QueryRow("SELECT image_path FROM gallery WHERE id=?", id).Scan(&p); err != nil {
		t.Fatal(err)
	}
	return p
}
func TestLocalGalleryReopenPersistsContent(t *testing.T) {
	dir := t.TempDir()
	dsn := "file:" + filepath.Join(dir, "persist.db")
	dataDir := filepath.Join(dir, "data")
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(db, time.Now, dataDir)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		_ = s.Close()
		t.Fatal(err)
	}
	saved, err := s.SaveGeneratedImage(ctx, localInsert("persist"))
	if err != nil {
		_ = s.Close()
		t.Fatal(err)
	}
	thumb := testutil.PNG(t, 2, 3)
	if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Status: "success", Thumb: thumb, ThumbMIME: "image/png"}); err != nil {
		_ = s.Close()
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := New(db, time.Now, dataDir)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if err := reopened.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	original, mime, err := reopened.PublicImageContent(ctx, saved.PublicID)
	if err != nil || mime != "image/png" || !bytes.Equal(original, localInsert("persist").Image) {
		t.Fatal("original not persistent", err)
	}
	got, mime, err := reopened.GalleryContent(ctx, saved.ID, true)
	if err != nil || mime != "image/png" || !bytes.Equal(got, thumb) {
		t.Fatal("thumbnail not persistent", err)
	}
}

func TestLocalGalleryOriginalNotInDatabase(t *testing.T) {
	s, dir := localGallery(t)
	ctx := context.Background()
	var blob, path int
	if err := s.db.QueryRow("SELECT count(*) FROM pragma_table_info('gallery') WHERE name='image'").Scan(&blob); err != nil {
		t.Fatal(err)
	}
	_ = s.db.QueryRow("SELECT count(*) FROM pragma_table_info('gallery') WHERE name='image_path'").Scan(&path)
	if blob != 0 || path != 1 {
		t.Fatal("original schema not local", blob, path)
	}
	saved, err := s.SaveGeneratedImage(ctx, localInsert("local"))
	if err != nil {
		t.Fatal(err)
	}
	p := originalPath(t, s, saved.ID)
	data, err := os.ReadFile(filepath.Join(dir, "images", filepath.FromSlash(p)))
	if err != nil || !bytes.Equal(data, localInsert("local").Image) {
		t.Fatal("original not on disk", err)
	}
	got, mime, err := s.PublicImageContent(ctx, saved.PublicID)
	if err != nil || mime != "image/png" || !bytes.Equal(got, data) {
		t.Fatal("public differs", err)
	}
}
func TestLocalGalleryDeduplicatesChangedBody(t *testing.T) {
	s, dir := localGallery(t)
	ctx := context.Background()
	in := localInsert("same")
	first, err := s.SaveGeneratedImage(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	in.Image = []byte("changed retry")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Go(func() {
			got, data, err := s.SaveDeliveryImage(ctx, in, true)
			if err != nil || got != first || string(data) != "first original" {
				t.Errorf("retry changed original: %+v %q %v", got, data, err)
			}
		})
	}
	wg.Wait()
	var count int
	_ = s.db.QueryRow("SELECT count(*) FROM gallery").Scan(&count)
	if count != 1 {
		t.Fatal("duplicates", count)
	}
	originals := 0
	_ = filepath.WalkDir(filepath.Join(dir, "images"), func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if !d.IsDir() && d.Name() == "original.png" {
			originals++
		}
		return nil
	})
	if originals != 1 {
		t.Fatal("candidate originals not cleaned", originals)
	}
}
func TestLocalGalleryFileFailureDoesNotPublishRow(t *testing.T) {
	s, dir := localGallery(t)
	if err := s.files.close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveGeneratedImage(context.Background(), localInsert("fail")); err == nil {
		t.Fatal("file failure published")
	}
	var count int
	_ = s.db.QueryRow("SELECT count(*) FROM gallery").Scan(&count)
	if count != 0 {
		t.Fatal("row published")
	}
	_ = dir
}
func TestLocalGalleryAmbiguousInsertKeepsFile(t *testing.T) {
	s, dir := localGallery(t)
	// A failing SQL statement must not trigger candidate cleanup, because remote errors may follow a commit.
	if _, err := s.db.Exec("DROP TABLE gallery"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveGeneratedImage(context.Background(), localInsert("ambiguous")); err == nil {
		t.Fatal("SQL error hidden")
	}
	originals := 0
	_ = filepath.WalkDir(filepath.Join(dir, "images"), func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if !d.IsDir() && d.Name() == "original.png" {
			originals++
		}
		return nil
	})
	if originals != 1 {
		t.Fatal("possibly committed candidate removed", originals)
	}
}
func TestLocalGalleryMissingOriginal(t *testing.T) {
	s, _ := localGallery(t)
	ctx := context.Background()
	saved, err := s.SaveGeneratedImage(ctx, localInsert("missing"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.files.remove(originalPath(t, s, saved.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PublicImageInfo(ctx, saved.PublicID); err == nil {
		t.Fatal("HEAD accepted missing original")
	}
	if _, _, err := s.PublicImageContent(ctx, saved.PublicID); err == nil {
		t.Fatal("GET accepted missing original")
	}
	if _, _, err := s.SaveDeliveryImage(ctx, localInsert("missing"), true); err == nil {
		t.Fatal("retry repaired or accepted missing original")
	}
}
func TestLocalGalleryDeleteClearReset(t *testing.T) {
	s, dir := localGallery(t)
	ctx := context.Background()
	sentinel := filepath.Join(dir, "keep.txt")
	_ = os.WriteFile(sentinel, []byte("keep"), 0600)
	saved, err := s.SaveGeneratedImage(ctx, localInsert("delete"))
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := s.DeleteGallery(ctx, saved.ID); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if _, err := s.files.stat(ctx, saved.PublicID[:2]+"/"+saved.PublicID+"/original.png"); !os.IsNotExist(err) {
		t.Fatal("original remains", err)
	}
	_, err = s.files.writeOriginal(ctx, localTestID, "image/png", []byte("orphan"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ResetSchema(ctx, false); err == nil {
		t.Fatal("unconfirmed reset")
	}
	if _, err := s.files.stat(ctx, "01/"+localTestID+"/original.png"); err != nil {
		t.Fatal("unconfirmed reset deleted", err)
	}
	if err := s.ClearGallery(ctx); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "images"))
	if len(entries) != 0 {
		t.Fatal("orphans remain")
	}
	saved, err = s.SaveGeneratedImage(ctx, localInsert("reset"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateAccount(ctx, "account", "secret"); err != nil {
		t.Fatal(err)
	}
	if err := s.ResetSchema(ctx, true); err != nil {
		t.Fatal(err)
	}
	var count int
	_ = s.db.QueryRow("SELECT count(*) FROM accounts").Scan(&count)
	if count != 0 {
		t.Fatal("accounts remain")
	}
	if _, err := s.PublicImageInfo(ctx, saved.PublicID); err == nil {
		t.Fatal("reset kept original")
	}
	entries, _ = os.ReadDir(filepath.Join(dir, "images"))
	if len(entries) != 0 {
		t.Fatal("reset files remain")
	}
	got, _ := os.ReadFile(sentinel)
	if string(got) != "keep" {
		t.Fatal("unrelated data removed")
	}
}
func TestLocalGalleryRejectsSchemaTwoWithoutCleaning(t *testing.T) {
	s, _ := localGallery(t)
	ctx := context.Background()
	saved, err := s.SaveGeneratedImage(ctx, localInsert("old"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.db.Exec("UPDATE app_meta SET value='2' WHERE key='schema'")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSchema(ctx); err == nil {
		t.Fatal("schema2 accepted")
	}
	if _, err := s.files.stat(ctx, originalPath(t, s, saved.ID)); err != nil {
		t.Fatal("startup removed data", err)
	}
}
