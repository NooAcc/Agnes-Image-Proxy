package store

import (
	"bytes"
	"context"
	"encoding/json"
	"path"
	"strings"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func newResourceStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(testutil.OpenDB(t), NewOptions{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InitializeStorage(context.Background(), domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		t.Fatal(err)
	}
	return s
}

func resourceItem(t *testing.T, s *Store, id int64) map[string]any {
	t.Helper()
	page, err := s.ListGallery(context.Background(), domain.CursorQuery{})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Items {
		if item.ID == id {
			raw, _ := json.Marshal(item)
			var result map[string]any
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			if _, ok := result["imageUrl"]; !ok {
				t.Fatal("gallery item missing imageUrl")
			}
			if _, ok := result["thumbnailUrl"]; !ok {
				t.Fatal("gallery item missing thumbnailUrl")
			}
			return result
		}
	}
	t.Fatalf("missing gallery ID %d", id)
	return nil
}

func TestPublicGalleryThumbnailRecovery(t *testing.T) {
	s := newResourceStore(t)
	ctx := context.Background()
	saved, err := s.SaveGeneratedImage(ctx, pngInsert(t, "recovery"))
	if err != nil {
		t.Fatal(err)
	}
	first := testutil.PNG(t, 2, 2)
	if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Thumb: first, ThumbMIME: "image/png", Status: "success"}); err != nil {
		t.Fatal(err)
	}
	var oldPath string
	if err := s.db.QueryRow(`SELECT thumb_path FROM gallery WHERE id = ?`, saved.ID).Scan(&oldPath); err != nil {
		t.Fatal(err)
	}
	oldName := path.Base(oldPath)
	got, err := s.PublicGalleryResource(ctx, saved.PublicID, oldName, false)
	if err != nil || !bytes.Equal(got.Data, first) {
		t.Fatalf("thumbnail = %+v %v", got, err)
	}
	if err := s.files.remove(oldPath); err != nil {
		t.Fatal(err)
	}
	got, err = s.PublicGalleryResource(ctx, saved.PublicID, oldName, false)
	if err != nil || !bytes.Equal(got.Data, first) {
		t.Fatalf("backup recovery = %+v %v", got, err)
	}
	item := resourceItem(t, s, saved.ID)
	currentName := path.Base(item["thumbnailUrl"].(string))
	head, err := s.PublicGalleryResource(ctx, saved.PublicID, currentName, true)
	if err != nil || len(head.Data) != 0 || head.Bytes != int64(len(first)) {
		t.Fatalf("HEAD = %+v %v", head, err)
	}
	second := testutil.PNG(t, 3, 3)
	if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Thumb: second, ThumbMIME: "image/png", Status: "success"}); err != nil {
		t.Fatal(err)
	}
	for _, stale := range []string{oldName, currentName} {
		if _, err := s.PublicGalleryResource(ctx, saved.PublicID, stale, false); err == nil {
			t.Fatal("stale thumbnail version served new bytes")
		}
	}
	newName := path.Base(resourceItem(t, s, saved.ID)["thumbnailUrl"].(string))
	got, err = s.PublicGalleryResource(ctx, saved.PublicID, newName, false)
	if err != nil || !bytes.Equal(got.Data, second) {
		t.Fatalf("new version = %+v %v", got, err)
	}
}

func TestPublicGalleryImgbedOriginalNotProxied(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2)}
	s, _ := newImgbedStore(t, fake, nil)
	ctx := context.Background()
	saved, err := s.SaveGeneratedImage(ctx, pngInsert(t, "not-proxied"))
	if err != nil {
		t.Fatal(err)
	}
	reads, heads := fake.reads, fake.heads
	for _, head := range []bool{false, true} {
		if _, err := s.PublicGalleryResource(ctx, saved.PublicID, "original.png", head); err == nil {
			t.Fatal("ImgBed original proxied via local resource")
		}
	}
	thumb := testutil.PNG(t, 1, 1)
	if err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Thumb: thumb, ThumbMIME: "image/png", Status: "success"}); err != nil {
		t.Fatal(err)
	}
	name := path.Base(resourceItem(t, s, saved.ID)["thumbnailUrl"].(string))
	got, err := s.PublicGalleryResource(ctx, saved.PublicID, name, false)
	if err != nil || !bytes.Equal(got.Data, thumb) {
		t.Fatalf("ImgBed thumbnail = %+v %v", got, err)
	}
	if fake.reads != reads || fake.heads != heads {
		t.Fatal("public resource contacted ImgBed")
	}
}

func TestGalleryResourceURLsLocal(t *testing.T) {
	s := newResourceStore(t)
	ctx := context.Background()
	for _, tc := range []struct{ mime, ext string }{{"image/png", "png"}, {"image/jpeg", "jpg"}, {"image/webp", "webp"}} {
		t.Run(tc.ext, func(t *testing.T) {
			in := pngInsert(t, "local:"+tc.ext)
			in.ImageMIME = &tc.mime
			saved, err := s.SaveGeneratedImage(ctx, in)
			if err != nil {
				t.Fatal(err)
			}
			item := resourceItem(t, s, saved.ID)
			want := "/images/" + saved.PublicID + "/original." + tc.ext
			if item["imageUrl"] != want || item["thumbnailUrl"] != nil {
				t.Fatalf("URLs = %+v, want %s", item, want)
			}
		})
	}
	id, err := s.InsertGallery(ctx, domain.GalleryInsert{OutputKey: "metadata-only"})
	if err != nil {
		t.Fatal(err)
	}
	item := resourceItem(t, s, id)
	if item["imageUrl"] != nil || item["thumbnailUrl"] != nil {
		t.Fatalf("metadata-only URLs = %+v", item)
	}
}

func TestGalleryResourceURLsImgbed(t *testing.T) {
	fake := &fakeImgbed{data: testutil.PNG(t, 2, 2)}
	s, _ := newImgbedStore(t, fake, nil)
	ctx := context.Background()
	in := pngInsert(t, "imgbed:urls")
	in.SourceURL = ptr("https://upstream.example/transient.png")
	saved, err := s.SaveGeneratedImage(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	reads, heads := fake.reads, fake.heads
	for _, origin := range []string{"https://old.example.com", "https://new.example.com"} {
		if origin != "https://old.example.com" {
			if _, err := s.UpdateImgbedStorage(ctx, domain.StorageUpdate{ImgbedBaseURL: origin}); err != nil {
				t.Fatal(err)
			}
		}
		item := resourceItem(t, s, saved.ID)
		want := origin + "/file/agnes-image-proxy/2026-11-24/" + saved.PublicID + ".png"
		if item["imageUrl"] != want || strings.Contains(item["imageUrl"].(string), "token") {
			t.Fatalf("URL = %v want %s", item["imageUrl"], want)
		}
		if item["sourceUrl"] != *in.SourceURL {
			t.Fatalf("upstream metadata changed: %+v", item)
		}
	}
	if fake.reads != reads || fake.heads != heads {
		t.Fatal("gallery list downloaded or probed ImgBed originals")
	}
}

func TestGalleryThumbnailURLVersion(t *testing.T) {
	s := newResourceStore(t)
	ctx := context.Background()
	saved, err := s.SaveGeneratedImage(ctx, pngInsert(t, "thumb:urls"))
	if err != nil {
		t.Fatal(err)
	}
	var previous string
	for _, size := range []int{2, 3} {
		err := s.SetEnrichment(ctx, saved.ID, domain.EnrichmentWrite{Thumb: testutil.PNG(t, size, size), ThumbMIME: "image/png", Status: "success"})
		if err != nil {
			t.Fatal(err)
		}
		item := resourceItem(t, s, saved.ID)
		got, ok := item["thumbnailUrl"].(string)
		if !ok || !strings.HasPrefix(got, "/images/"+saved.PublicID+"/thumb-") || path.Ext(got) != ".png" || got == previous {
			t.Fatalf("thumbnail URL = %v, previous %s", item["thumbnailUrl"], previous)
		}
		previous = got
	}
	if _, err := s.db.Exec(`UPDATE gallery SET thumb_mime = 'image/jpeg' WHERE id = ?`, saved.ID); err != nil {
		t.Fatal(err)
	}
	if got := resourceItem(t, s, saved.ID)["thumbnailUrl"]; got != nil {
		t.Fatalf("invalid thumbnail published: %v", got)
	}
}
