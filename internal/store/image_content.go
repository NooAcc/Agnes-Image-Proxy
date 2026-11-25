package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const imageInfoColumns = `SELECT id, public_id, image_mime, image_bytes, original_ref FROM gallery`

func (s *Store) ImageInfo(ctx context.Context, id int64) (domain.StoredImage, error) {
	return s.imageInfo(ctx, "id", id)
}
func (s *Store) PublicImageInfo(ctx context.Context, id string) (domain.StoredImage, error) {
	return s.imageInfo(ctx, "public_id", id)
}

func (s *Store) imageMetadata(ctx context.Context, column string, value any) (domain.StoredImage, error) {
	dbCtx, cancel := s.operation(ctx)
	defer cancel()
	var image domain.StoredImage
	var mime, ref sql.NullString
	var size sql.NullInt64
	err := s.db.QueryRowContext(dbCtx, imageInfoColumns+" WHERE "+column+" = ?", value).Scan(&image.ID, &image.PublicID, &mime, &size, &ref)
	if errors.Is(err, sql.ErrNoRows) {
		return image, galleryNotFound()
	}
	if err != nil {
		return image, classifyDBError(err)
	}
	if !originalIdentityValid(image.PublicID, ref.String, mime.String) || !size.Valid || size.Int64 <= 0 {
		return image, galleryNotFound()
	}
	image.MIME, image.Bytes, image.Ref = mime.String, size.Int64, ref.String
	return image, nil
}

func (s *Store) imageInfo(ctx context.Context, column string, value any) (domain.StoredImage, error) {
	ctx, cancel := context.WithTimeout(ctx, originalOperationBudget)
	defer cancel()
	backend, release, err := s.beginOriginal(ctx)
	if err != nil {
		return domain.StoredImage{}, err
	}
	defer release()
	s.galleryGate.RLock()
	defer s.galleryGate.RUnlock()
	image, err := s.imageMetadata(ctx, column, value)
	if err != nil {
		return domain.StoredImage{}, err
	}
	unlock := s.imageLocks.lock(fmt.Sprint(image.ID))
	defer unlock()
	image, err = s.imageMetadata(ctx, column, value)
	if err != nil {
		return domain.StoredImage{}, err
	}
	if err := backend.Verify(ctx, image.Ref, image.MIME, image.Bytes); err != nil {
		return domain.StoredImage{}, mapOriginalError(err)
	}
	return image, nil
}

func (s *Store) PublicImageContent(ctx context.Context, id string) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, originalOperationBudget)
	defer cancel()
	backend, release, err := s.beginOriginal(ctx)
	if err != nil {
		return nil, "", err
	}
	defer release()
	s.galleryGate.RLock()
	defer s.galleryGate.RUnlock()
	image, err := s.imageMetadata(ctx, "public_id", id)
	if err != nil {
		return nil, "", err
	}
	unlock := s.imageLocks.lock(fmt.Sprint(image.ID))
	defer unlock()
	return s.originalContent(ctx, backend, "public_id", id)
}

func (s *Store) originalContent(ctx context.Context, backend originalBackend, column string, value any) ([]byte, string, error) {
	image, err := s.imageMetadata(ctx, column, value)
	if err != nil {
		return nil, "", err
	}
	data, err := backend.Read(ctx, image.Ref, image.MIME, image.Bytes)
	if err != nil {
		return nil, "", mapOriginalError(err)
	}
	return data, image.MIME, nil
}

func validThumbIdentity(id, path, mime string) bool {
	ext, err := fileExtension(mime)
	return validPublicID(id) && err == nil && safeImagePath(path) && strings.HasPrefix(path, id[:2]+"/"+id+"/thumb-") && strings.HasSuffix(path, "."+ext)
}

// Caller holds both the gallery read gate and picture lock through recovery.
func (s *Store) thumbnailContent(ctx context.Context, id int64) ([]byte, string, error) {
	var publicID string
	var path, mime sql.NullString
	var size sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT public_id, thumb_path, thumb_mime, thumb_bytes FROM gallery WHERE id = ?`, id).Scan(&publicID, &path, &mime, &size)
	if err == sql.ErrNoRows {
		return nil, "", galleryNotFound()
	}
	if err != nil {
		return nil, "", classifyDBError(err)
	}
	if !path.Valid || !mime.Valid || !size.Valid || size.Int64 <= 0 {
		return nil, "", galleryNotFound()
	}
	if !validThumbIdentity(publicID, path.String, mime.String) {
		return nil, "", localStorageError(errors.New("invalid thumbnail identity"))
	}
	data, err := s.files.read(ctx, path.String)
	if err == nil {
		if int64(len(data)) != size.Int64 {
			return nil, "", localStorageError(errors.New("thumbnail length mismatch"))
		}
		return data, mime.String, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, "", localStorageError(err)
	}
	// The path predicate binds this BLOB to precisely the metadata version read above.
	err = s.db.QueryRowContext(ctx, `SELECT thumb FROM gallery WHERE id = ? AND thumb_path = ? AND thumb_mime = ? AND thumb_bytes = ?`, id, path.String, mime.String, size.Int64).Scan(&data)
	if err == sql.ErrNoRows {
		return nil, "", galleryNotFound()
	}
	if err != nil {
		return nil, "", classifyDBError(err)
	}
	if int64(len(data)) != size.Int64 {
		return nil, "", localStorageError(errors.New("thumbnail backup length mismatch"))
	}
	newPath, writeErr := s.files.writeThumbnail(ctx, publicID, mime.String, data)
	if writeErr != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return data, mime.String, nil
	}
	result, err := s.db.ExecContext(ctx, `UPDATE gallery SET thumb_path = ? WHERE id = ? AND thumb_path = ? AND thumb_mime = ? AND thumb_bytes = ?`, newPath, id, path.String, mime.String, size.Int64)
	if err != nil {
		return nil, "", classifyDBError(err)
	} // Retain possibly referenced candidate.
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, "", classifyDBError(err)
	}
	if affected == 0 {
		return nil, "", galleryNotFound()
	}
	if err := s.files.remove(path.String); err != nil {
		return nil, "", localStorageError(err)
	}
	return data, mime.String, nil
}
