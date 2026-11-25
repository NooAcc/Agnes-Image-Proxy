package store

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/imgbed"
)

// originalOperationBudget bounds one full original lifecycle, including
// remote network work. Database phases retain their own shorter budget.
const originalOperationBudget = 60 * time.Second

// originalBackend stores, verifies, reads and deletes originals for one fixed
// storage mode. A backend is always bound to an immutable configuration
// snapshot.
type originalBackend interface {
	Write(ctx context.Context, publicID, mime string, data []byte) (ref string, verified []byte, err error)
	Read(ctx context.Context, ref, mime string, size int64) ([]byte, error)
	Verify(ctx context.Context, ref, mime string, size int64) error
	Delete(ctx context.Context, ref string) error
}

type localBackend struct {
	files *localFiles
}

func (b localBackend) Write(ctx context.Context, publicID, mime string, data []byte) (string, []byte, error) {
	ref, err := b.files.writeOriginal(ctx, publicID, mime, data)
	if err != nil {
		return "", nil, localStorageError(err)
	}
	verified, err := b.files.read(ctx, ref)
	if err != nil {
		return "", nil, localStorageError(err)
	}
	if !bytes.Equal(verified, data) {
		_ = b.files.remove(ref)
		return "", nil, localStorageError(errors.New("local original read-back mismatch"))
	}
	return ref, verified, nil
}

func (b localBackend) Read(ctx context.Context, ref, mime string, size int64) ([]byte, error) {
	if !localOriginalRef(ref, mime) {
		return nil, localStorageError(errors.New("invalid local original reference"))
	}
	data, err := b.files.read(ctx, ref)
	if err != nil {
		return nil, localStorageError(err)
	}
	if size > 0 && int64(len(data)) != size {
		return nil, localStorageError(errors.New("local original length mismatch"))
	}
	return data, nil
}

func (b localBackend) Verify(ctx context.Context, ref, mime string, size int64) error {
	if !localOriginalRef(ref, mime) {
		return localStorageError(errors.New("invalid local original reference"))
	}
	actual, err := b.files.stat(ctx, ref)
	if err != nil {
		return localStorageError(err)
	}
	if actual != size {
		return localStorageError(errors.New("local original length mismatch"))
	}
	return nil
}

func (b localBackend) Delete(ctx context.Context, ref string) error {
	if !safeImagePath(ref) {
		return localStorageError(errors.New("invalid local original reference"))
	}
	return localStorageError(b.files.remove(ref))
}

func localOriginalRef(ref, mime string) bool {
	ext, err := fileExtension(mime)
	if err != nil {
		return false
	}
	if !safeImagePath(ref) {
		return false
	}
	return strings.HasSuffix(ref, "/original."+ext)
}

type imgbedBackend struct {
	client *imgbed.Client
}

func (b imgbedBackend) Write(ctx context.Context, publicID, mime string, data []byte) (string, []byte, error) {
	object, verified, err := b.client.Upload(ctx, publicID, mime, data)
	if err != nil {
		return "", nil, err
	}
	return object.Ref, verified, nil
}

func (b imgbedBackend) Read(ctx context.Context, ref, mime string, size int64) ([]byte, error) {
	return b.client.Read(ctx, imgbed.Object{Ref: ref, MIME: mime, Bytes: size})
}

func (b imgbedBackend) Verify(ctx context.Context, ref, mime string, size int64) error {
	return b.client.Head(ctx, imgbed.Object{Ref: ref, MIME: mime, Bytes: size})
}

func (b imgbedBackend) Delete(ctx context.Context, ref string) error {
	return b.client.Delete(ctx, ref)
}

func initializationRequired() error {
	return apierror.Coded(503, "storage is not initialized", "server_error", "initialization_required")
}

// beginOriginal takes a shared configuration snapshot and builds the backend.
// The release function must be called after the whole original operation.
func (s *Store) beginOriginal(ctx context.Context) (originalBackend, func(), error) {
	release, err := s.storageGate.acquire(ctx, false)
	if err != nil {
		return nil, nil, err
	}
	dbCtx, cancel := s.operation(ctx)
	config, found, err := s.readStorageConfig(dbCtx)
	cancel()
	if err != nil {
		release()
		return nil, nil, err
	}
	if !found {
		release()
		return nil, nil, initializationRequired()
	}
	backend, err := s.backendFor(config)
	if err != nil {
		release()
		return nil, nil, err
	}
	return backend, release, nil
}

func (s *Store) backendFor(config domain.StorageConfig) (originalBackend, error) {
	switch config.Mode {
	case domain.StorageLocal:
		return localBackend{files: s.files}, nil
	case domain.StorageImgbed:
		client, err := imgbed.New(config, s.imgbedOptions)
		if err != nil {
			return nil, apierror.Coded(503, "stored storage configuration is invalid", "server_error", "invalid_storage_config")
		}
		return imgbedBackend{client: client}, nil
	default:
		return nil, invalidStorageConfig()
	}
}

// mapOriginalError converts a backend failure into the public error contract.
// Not-found stays 404; permission, transport, MIME and length failures are all
// storage unavailability, never "missing".
func mapOriginalError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, imgbed.ErrNotFound) {
		return galleryNotFound()
	}
	var apiErr *apierror.Error
	if errors.As(err, &apiErr) {
		return err
	}
	return apierror.Coded(503, "original image storage unavailable", "server_error", "image_storage_unavailable")
}

func originalIdentityValid(publicID, ref, mime string) bool {
	if !validPublicID(publicID) || !validStoredMIME(mime) || strings.TrimSpace(ref) == "" {
		return false
	}
	return true
}
