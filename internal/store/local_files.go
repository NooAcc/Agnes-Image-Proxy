package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

// localFiles owns only the images namespace, not the configured data directory.
// Root pins that namespace and confines every operation even after symlink changes.
type localFiles struct{ root *os.Root }

func newLocalFiles(dataDir string) (*localFiles, error) {
	if strings.TrimSpace(dataDir) == "" || (dataDir != "/data" && !filepath.IsAbs(dataDir)) {
		return nil, fmt.Errorf("DATA_DIR must be a non-empty absolute directory")
	}
	if err := os.MkdirAll(dataDir, 0750); err != nil {
		return nil, fmt.Errorf("DATA_DIR cannot be created: %w", err)
	}
	base, err := os.OpenRoot(dataDir)
	if err != nil {
		return nil, fmt.Errorf("DATA_DIR cannot be opened: %w", err)
	}
	defer base.Close()
	if err := base.MkdirAll("images", 0750); err != nil {
		return nil, fmt.Errorf("DATA_DIR images cannot be created: %w", err)
	}
	info, err := base.Lstat("images")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("DATA_DIR images must be a real directory")
	}
	root, err := openCheckedNamespace(base, info)
	if err != nil {
		return nil, fmt.Errorf("DATA_DIR images cannot be opened: %w", err)
	}
	if err := syncDirectoryChain(base, "images"); err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("DATA_DIR image namespace cannot be persisted: %w", err)
	}
	f := &localFiles{root: root}
	name, err := randomFileName(".probe-")
	if err == nil {
		var probe *os.File
		probe, err = root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0640)
		if err == nil {
			err = errors.Join(probe.Sync(), probe.Close())
			err = errors.Join(err, root.Remove(name))
		}
	}
	if err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("DATA_DIR images must be writable: %w", err)
	}
	return f, nil
}

// Check the opened handle, not a second pathname lookup: a relative symlink
// may stay inside DATA_DIR while selecting an unrelated namespace.
func openCheckedNamespace(base *os.Root, expected os.FileInfo) (*os.Root, error) {
	root, err := base.OpenRoot("images")
	if err != nil {
		return nil, err
	}
	actual, err := root.Stat(".")
	if err != nil || !os.SameFile(expected, actual) {
		_ = root.Close()
		return nil, errors.New("image namespace changed during initialization")
	}
	return root, nil
}

func randomFileName(prefix string) (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(id[:]), nil
}
func validPublicID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, r := range id {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
func fileExtension(mime string) (string, error) {
	switch mime {
	case "image/png":
		return "png", nil
	case "image/jpeg":
		return "jpg", nil
	case "image/webp":
		return "webp", nil
	}
	return "", errors.New("unsupported image MIME")
}
func safeImagePath(path string) bool {
	if strings.Contains(path, "\\") || filepath.IsAbs(path) {
		return false
	}
	parts := strings.Split(path, "/")
	if len(parts) != 3 || !validPublicID(parts[1]) || parts[0] != parts[1][:2] {
		return false
	}
	name := parts[2]
	dot := strings.LastIndexByte(name, '.')
	if dot < 0 {
		return false
	}
	ext := name[dot+1:]
	if ext != "png" && ext != "jpg" && ext != "webp" {
		return false
	}
	stem := name[:dot]
	return stem == "original" || strings.HasPrefix(stem, "thumb-") && validPublicID(strings.TrimPrefix(stem, "thumb-"))
}
func (f *localFiles) writeOriginal(ctx context.Context, id, mime string, data []byte) (string, error) {
	return f.write(ctx, id, mime, data, false)
}
func (f *localFiles) writeThumbnail(ctx context.Context, id, mime string, data []byte) (string, error) {
	return f.write(ctx, id, mime, data, true)
}
func (f *localFiles) write(ctx context.Context, id, mime string, data []byte, thumbnail bool) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if !validPublicID(id) || len(data) == 0 {
		return "", errors.New("invalid local image")
	}
	ext, err := fileExtension(mime)
	if err != nil {
		return "", err
	}
	dir := id[:2] + "/" + id
	if err := f.root.MkdirAll(dir, 0750); err != nil {
		return "", err
	}
	// Pin the picture directory so publication cannot switch directories mid-write.
	root, err := f.root.OpenRoot(dir)
	if err != nil {
		return "", err
	}
	defer root.Close()
	name := "original." + ext
	if thumbnail {
		version, e := randomFileName("thumb-")
		if e != nil {
			return "", e
		}
		name = version + "." + ext
	}
	temp, err := randomFileName(".tmp-")
	if err != nil {
		return "", err
	}
	out, err := root.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0640)
	if err != nil {
		return "", err
	}
	defer root.Remove(temp)
	if err = ctx.Err(); err == nil {
		_, err = out.Write(data)
	}
	if err == nil {
		err = out.Sync()
	}
	err = errors.Join(err, out.Close())
	if err != nil {
		return "", err
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	// Hard-link publication is atomic and fails if an authoritative original exists.
	// Rename on Unix would silently replace it; immutable candidates use the same rule.
	if err = root.Link(temp, name); err != nil {
		return "", err
	}
	if err = root.Remove(temp); err != nil {
		return "", err
	}
	if err := syncDirectoryChain(root, "."); err != nil {
		return "", err
	}
	if err := syncDirectoryChain(f.root, dir); err != nil {
		return "", err
	}
	return dir + "/" + name, nil
}
func (f *localFiles) open(ctx context.Context, path string) (*os.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !safeImagePath(path) {
		return nil, errors.New("invalid local image path")
	}
	file, err := f.root.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		if err == nil {
			err = errors.New("image is not a regular file")
		}
		return nil, err
	}
	return file, nil
}
func (f *localFiles) read(ctx context.Context, path string) ([]byte, error) {
	file, err := f.open(ctx, path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return data, nil
}
func (f *localFiles) stat(ctx context.Context, path string) (int64, error) {
	file, err := f.open(ctx, path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}
func (f *localFiles) remove(path string) error {
	if !safeImagePath(path) {
		return errors.New("invalid local image path")
	}
	err := f.root.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
func (f *localFiles) removeImage(id string) error {
	if !validPublicID(id) {
		return errors.New("invalid local image identity")
	}
	return f.root.RemoveAll(id[:2] + "/" + id)
}
func (f *localFiles) clear() error {
	dir, err := f.root.Open(".")
	if err != nil {
		return err
	}
	entries, err := dir.ReadDir(-1)
	err = errors.Join(err, dir.Close())
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := f.root.RemoveAll(entry.Name()); err != nil {
			return err
		}
	}
	return nil
}
func (f *localFiles) close() error {
	if f == nil || f.root == nil {
		return nil
	}
	return f.root.Close()
}
func localStorageError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, os.ErrNotExist) {
		return galleryNotFound()
	}
	return apierror.Coded(503, "local image storage unavailable", "server_error", "image_storage_unavailable")
}
