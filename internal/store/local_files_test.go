package store

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const localTestID = "0123456789abcdef0123456789abcdef"

func testLocalFiles(t *testing.T) (*localFiles, string) {
	t.Helper()
	dir := t.TempDir()
	f, err := newLocalFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := f.close(); err != nil {
			t.Error(err)
		}
	})
	return f, dir
}

func TestLocalFilesRejectSymlinkNamespace(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, "unrelated")
	if err := os.Mkdir(sibling, 0750); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(sibling, "keep.txt")
	_ = os.WriteFile(sentinel, []byte("keep"), 0600)
	if err := os.Symlink("unrelated", filepath.Join(dir, "images")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	f, err := newLocalFiles(dir)
	if err == nil {
		_ = f.close()
		t.Fatal("symlink namespace accepted")
	}
	got, _ := os.ReadFile(sentinel)
	if string(got) != "keep" {
		t.Fatal("unrelated namespace changed")
	}
}

func TestLocalFilesRejectNamespaceReplacement(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "images"), 0750); err != nil {
		t.Fatal(err)
	}
	base, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	expected, err := base.Lstat("images")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "images"), filepath.Join(dir, "old-images")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "images"), 0750); err != nil {
		t.Fatal(err)
	}
	root, err := openCheckedNamespace(base, expected)
	if err == nil {
		_ = root.Close()
		t.Fatal("changed namespace identity accepted")
	}
}

func TestLocalFilesPublishedDirectoryChain(t *testing.T) {
	f, _ := testLocalFiles(t)
	path, err := f.writeOriginal(context.Background(), localTestID, "image/png", []byte("durable"))
	if err != nil {
		t.Fatal(err)
	}
	if err := syncDirectoryChain(f.root, "01/"+localTestID); err != nil {
		t.Fatal("cannot persist published namespace", err)
	}
	data, err := f.read(context.Background(), path)
	if err != nil || string(data) != "durable" {
		t.Fatal("published content changed", err)
	}
}

func TestLocalFilesOriginalRoundTrip(t *testing.T) {
	f, dir := testLocalFiles(t)
	input := []byte("original png")
	path, err := f.writeOriginal(context.Background(), localTestID, "image/png", input)
	if err != nil {
		t.Fatal(err)
	}
	if path != "01/"+localTestID+"/original.png" {
		t.Fatalf("path %q", path)
	}
	got, err := f.read(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	size, err := f.stat(context.Background(), path)
	if err != nil || size != int64(len(input)) || !bytes.Equal(got, input) {
		t.Fatal("file round trip", size, err)
	}
	if _, err := f.writeOriginal(context.Background(), localTestID, "image/png", []byte("replacement")); err == nil {
		t.Fatal("overwrote original")
	}
	got, _ = f.read(context.Background(), path)
	if !bytes.Equal(got, input) {
		t.Fatal("original changed")
	}
	entries, err := os.ReadDir(filepath.Join(dir, "images", "01", localTestID))
	if err != nil || len(entries) != 1 {
		t.Fatal("unpublished temporary files", entries, err)
	}
}

func TestLocalFilesThumbnailVersions(t *testing.T) {
	f, _ := testLocalFiles(t)
	a, err := f.writeThumbnail(context.Background(), localTestID, "image/png", []byte("first"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.writeThumbnail(context.Background(), localTestID, "image/webp", []byte("second"))
	if err != nil || a == b {
		t.Fatal("thumbnail version overwritten", err)
	}
	x, _ := f.read(context.Background(), a)
	y, _ := f.read(context.Background(), b)
	if string(x) != "first" || string(y) != "second" {
		t.Fatal("version changed")
	}
}

func TestLocalFilesRejectUnsafePaths(t *testing.T) {
	f, dir := testLocalFiles(t)
	sentinel := filepath.Join(dir, "keep.txt")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../keep.txt", sentinel, "01/../../keep.txt", "", "01/" + localTestID + "/../original.png"} {
		if _, err := f.read(context.Background(), path); err == nil {
			t.Errorf("read accepted %q", path)
		}
		if _, err := f.stat(context.Background(), path); err == nil {
			t.Errorf("stat accepted %q", path)
		}
		if err := f.remove(path); err == nil {
			t.Errorf("remove accepted %q", path)
		}
	}
	for _, id := range []string{"../outside", strings.ToUpper(localTestID), "short", strings.Repeat("z", 32)} {
		if _, err := f.writeOriginal(context.Background(), id, "image/png", []byte("bad")); err == nil {
			t.Errorf("write accepted %q", id)
		}
		if err := f.removeImage(id); err == nil {
			t.Errorf("remove accepted %q", id)
		}
	}
	got, _ := os.ReadFile(sentinel)
	if string(got) != "keep" {
		t.Fatal("external file changed")
	}
}

func TestLocalFilesSymlinkEscape(t *testing.T) {
	f, dir := testLocalFiles(t)
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "images", "01")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := f.writeOriginal(context.Background(), localTestID, "image/png", []byte("bad")); err == nil {
		t.Fatal("symlink write escaped")
	}
	if _, err := f.read(context.Background(), "01/"+localTestID+"/original.png"); err == nil {
		t.Fatal("symlink read escaped")
	}
	_ = f.removeImage(localTestID)
	if err := f.clear(); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(sentinel)
	if string(got) != "keep" {
		t.Fatal("external sentinel changed")
	}
}

func TestLocalFilesClearOwnsOnlyNamespace(t *testing.T) {
	f, dir := testLocalFiles(t)
	sentinel := filepath.Join(dir, "keep.txt")
	_ = os.WriteFile(sentinel, []byte("keep"), 0600)
	_, err := f.writeOriginal(context.Background(), localTestID, "image/png", []byte("original"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.clear(); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(sentinel)
	if string(got) != "keep" {
		t.Fatal("root sentinel changed")
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "images"))
	if len(entries) != 0 {
		t.Fatal("images not cleared")
	}
	if _, err := f.writeOriginal(context.Background(), localTestID, "image/png", []byte("new")); err != nil {
		t.Fatal("root not reusable", err)
	}
}

func TestLocalFilesCanceledWrite(t *testing.T) {
	f, dir := testLocalFiles(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.writeOriginal(ctx, localTestID, "image/png", []byte("bad")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "images"))
	if len(entries) != 0 {
		t.Fatal("canceled write left files")
	}
}

func TestLocalFilesUnwritableRoot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(path, []byte("occupied"), 0600)
	if f, err := newLocalFiles(path); err == nil {
		_ = f.close()
		t.Fatal("file accepted as directory")
	}
}

func TestLocalFilesMissingDistinct(t *testing.T) {
	f, _ := testLocalFiles(t)
	path := "01/" + localTestID + "/original.png"
	if _, err := f.read(context.Background(), path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("missing classification", err)
	}
	if _, err := f.stat(context.Background(), path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("missing stat", err)
	}
}
