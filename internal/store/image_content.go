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

const imageInfoColumns = `SELECT id, public_id, image_mime, image_bytes, image_path FROM gallery`

func (s *Store) ImageInfo(ctx context.Context, id int64) (domain.StoredImage, error) {
	return s.imageInfo(ctx, "id", id)
}
func (s *Store) PublicImageInfo(ctx context.Context, id string) (domain.StoredImage, error) {
	return s.imageInfo(ctx, "public_id", id)
}
func (s *Store) imageMetadata(ctx context.Context, column string, value any) (domain.StoredImage, string, error) {
	var image domain.StoredImage
	var mime, path sql.NullString
	var size sql.NullInt64
	err := s.db.QueryRowContext(ctx, imageInfoColumns+" WHERE "+column+" = ?", value).Scan(&image.ID, &image.PublicID, &mime, &size, &path)
	if errors.Is(err, sql.ErrNoRows) {
		return image, "", galleryNotFound()
	}
	if err != nil {
		return image, "", classifyDBError(err)
	}
	if !validPublicID(image.PublicID) || !mime.Valid || !validStoredMIME(mime.String) || !size.Valid || size.Int64 <= 0 || !path.Valid {
		return image, "", galleryNotFound()
	}
	image.MIME, image.Bytes = mime.String, size.Int64
	ext, err := fileExtension(image.MIME)
	if err != nil || path.String != image.PublicID[:2]+"/"+image.PublicID+"/original."+ext {
		return image, "", localStorageError(errors.New("invalid original identity"))
	}
	return image, path.String, nil
}
func (s *Store) verifyOriginal(ctx context.Context, image domain.StoredImage, path string) (domain.StoredImage, error) {
	size, err := s.files.stat(ctx, path)
	if err != nil {
		return domain.StoredImage{}, localStorageError(err)
	}
	if size != image.Bytes {
		return domain.StoredImage{}, localStorageError(errors.New("original length mismatch"))
	}
	return image, nil
}
func (s *Store) readOriginal(ctx context.Context, image domain.StoredImage, path string) ([]byte, error) {
	data, err := s.files.read(ctx, path)
	if err != nil {
		return nil, localStorageError(err)
	}
	if int64(len(data)) != image.Bytes {
		return nil, localStorageError(errors.New("original length mismatch"))
	}
	return data, nil
}
func (s *Store) imageInfo(ctx context.Context, column string, value any) (domain.StoredImage, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	s.galleryGate.RLock()
	defer s.galleryGate.RUnlock()
	image, path, err := s.imageMetadata(ctx, column, value)
	if err != nil {
		return domain.StoredImage{}, err
	}
	unlock := s.imageLocks.lock(fmt.Sprint(image.ID))
	defer unlock()
	image, path, err = s.imageMetadata(ctx, column, value)
	if err != nil {
		return domain.StoredImage{}, err
	}
	return s.verifyOriginal(ctx, image, path)
}
func (s *Store) PublicImageContent(ctx context.Context, id string) ([]byte, string, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	s.galleryGate.RLock()
	defer s.galleryGate.RUnlock()
	image, _, err := s.imageMetadata(ctx, "public_id", id)
	if err != nil {
		return nil, "", err
	}
	unlock := s.imageLocks.lock(fmt.Sprint(image.ID))
	defer unlock()
	return s.originalContent(ctx, "public_id", id)
}
func (s *Store) originalContent(ctx context.Context, column string, value any) ([]byte, string, error) {
	image, path, err := s.imageMetadata(ctx, column, value)
	if err != nil {
		return nil, "", err
	}
	data, err := s.readOriginal(ctx, image, path)
	return data, image.MIME, err
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
