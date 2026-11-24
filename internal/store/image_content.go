package store

import (
	"context"
	"database/sql"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// imageInfoColumns deliberately excludes the original BLOB.
const imageInfoColumns = `SELECT id, public_id, image_mime, image_bytes FROM gallery`

func (s *Store) ImageInfo(ctx context.Context, id int64) (domain.StoredImage, error) {
	return s.imageInfo(ctx, "id", id)
}
func (s *Store) PublicImageInfo(ctx context.Context, publicID string) (domain.StoredImage, error) {
	return s.imageInfo(ctx, "public_id", publicID)
}
func (s *Store) imageInfo(ctx context.Context, column string, value any) (domain.StoredImage, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var image domain.StoredImage
	var mime sql.NullString
	var size sql.NullInt64
	err := s.db.QueryRowContext(ctx, imageInfoColumns+" WHERE "+column+" = ?", value).Scan(&image.ID, &image.PublicID, &mime, &size)
	if err == sql.ErrNoRows {
		return domain.StoredImage{}, galleryNotFound()
	}
	if err != nil {
		return domain.StoredImage{}, classifyDBError(err)
	}
	if !mime.Valid || !validStoredMIME(mime.String) || !size.Valid || size.Int64 <= 0 {
		return domain.StoredImage{}, galleryNotFound()
	}
	image.MIME, image.Bytes = mime.String, size.Int64
	return image, nil
}
func (s *Store) PublicImageContent(ctx context.Context, publicID string) ([]byte, string, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var data []byte
	var mime sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT image, image_mime FROM gallery WHERE public_id = ?`, publicID).Scan(&data, &mime)
	if err == sql.ErrNoRows {
		return nil, "", galleryNotFound()
	}
	if err != nil {
		return nil, "", classifyDBError(err)
	}
	if len(data) == 0 || !mime.Valid || !validStoredMIME(mime.String) {
		return nil, "", galleryNotFound()
	}
	return data, mime.String, nil
}
