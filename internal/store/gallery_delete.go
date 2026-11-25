package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const deletePageSize = 100

// DeleteGallery removes one row and its original. The row and reference stay
// intact when the original cannot be deleted, so an administrator can retry.
func (s *Store) DeleteGallery(ctx context.Context, id int64) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, originalOperationBudget)
	defer cancel()
	backend, release, err := s.beginOriginal(ctx)
	if err != nil {
		return false, err
	}
	defer release()
	s.galleryGate.RLock()
	defer s.galleryGate.RUnlock()
	unlock := s.imageLocks.lock(fmt.Sprint(id))
	defer unlock()
	return s.deleteGalleryLocked(ctx, backend, id)
}

// deleteGalleryLocked assumes the caller holds the storage snapshot and the
// gallery/picture locks. It deletes the original first so a failure never
// loses the only remote locator.
func (s *Store) deleteGalleryLocked(ctx context.Context, backend originalBackend, id int64) (bool, error) {
	dbCtx, cancel := s.operation(ctx)
	var (
		publicID string
		ref      sql.NullString
		mime     sql.NullString
		bytes    sql.NullInt64
	)
	err := s.db.QueryRowContext(dbCtx, `SELECT public_id, original_ref, image_mime, image_bytes FROM gallery WHERE id = ?`, id).
		Scan(&publicID, &ref, &mime, &bytes)
	cancel()
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, classifyDBError(err)
	}
	if ref.Valid && ref.String != "" {
		if err := backend.Delete(ctx, ref.String); err != nil {
			return false, mapOriginalError(err)
		}
	}
	dbCtx, cancel = s.operation(ctx)
	result, err := s.db.ExecContext(dbCtx, `DELETE FROM gallery WHERE id = ? AND public_id = ?`, id, publicID)
	cancel()
	if err != nil {
		// The remote object may already be gone; keep the row so an idempotent
		// retry can finish.
		return false, classifyDBError(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, classifyDBError(err)
	}
	if affected > 0 {
		if err := s.files.removeImage(publicID); err != nil {
			return false, localStorageError(err)
		}
	}
	return affected > 0, nil
}

// ClearGallery removes every gallery row and its original. A failure stops the
// pass, leaving the failed row and every unprocessed row in place for retry.
func (s *Store) ClearGallery(ctx context.Context) error {
	backend, release, err := s.beginOriginal(ctx)
	if err != nil {
		return err
	}
	defer release()
	s.galleryGate.Lock()
	defer s.galleryGate.Unlock()
	return s.clearGalleryLocked(ctx, backend)
}

// clearGalleryLocked assumes storage and exclusive gallery gates are held.
func (s *Store) clearGalleryLocked(ctx context.Context, backend originalBackend) error {
	generation, err := randomFileName("")
	if err != nil {
		return err
	}
	dbCtx, cancel := s.operation(ctx)
	tx, err := s.db.BeginTx(dbCtx, nil)
	if err != nil {
		cancel()
		return classifyDBError(err)
	}
	if _, err := tx.ExecContext(dbCtx, `UPDATE app_meta SET value = ? WHERE key='gallery_generation'`, generation); err != nil {
		cancel()
		_ = tx.Rollback()
		return classifyDBError(err)
	}
	if err := tx.Commit(); err != nil {
		cancel()
		return classifyDBError(err)
	}
	cancel()

	var cursor int64
	for {
		page, err := s.deletePage(ctx, cursor)
		if err != nil {
			return err
		}
		if len(page) == 0 {
			break
		}
		for _, image := range page {
			objectCtx, objectCancel := context.WithTimeout(ctx, originalOperationBudget)
			var deleteErr error
			if image.Ref != "" {
				deleteErr = backend.Delete(objectCtx, image.Ref)
			}
			objectCancel()
			if deleteErr != nil {
				return mapOriginalError(deleteErr)
			}
			dbCtx, cancel := s.operation(ctx)
			_, err := s.db.ExecContext(dbCtx, `DELETE FROM gallery WHERE id = ? AND public_id = ?`, image.ID, image.PublicID)
			cancel()
			if err != nil {
				return classifyDBError(err)
			}
			cursor = image.ID
		}
		if len(page) < deletePageSize {
			break
		}
	}
	return localStorageError(s.files.clear())
}

func (s *Store) deletePage(ctx context.Context, after int64) ([]domain.StoredImage, error) {
	dbCtx, cancel := s.operation(ctx)
	defer cancel()
	rows, err := s.db.QueryContext(dbCtx,
		`SELECT id, public_id, original_ref, image_mime, image_bytes FROM gallery WHERE id > ? ORDER BY id ASC LIMIT ?`,
		after, deletePageSize)
	if err != nil {
		return nil, classifyDBError(err)
	}
	defer rows.Close()
	var page []domain.StoredImage
	for rows.Next() {
		var (
			image domain.StoredImage
			ref   sql.NullString
			mime  sql.NullString
			bytes sql.NullInt64
		)
		if err := rows.Scan(&image.ID, &image.PublicID, &ref, &mime, &bytes); err != nil {
			return nil, classifyDBError(err)
		}
		if ref.Valid {
			image.Ref = ref.String
		}
		if mime.Valid {
			image.MIME = mime.String
		}
		if bytes.Valid {
			image.Bytes = bytes.Int64
		}
		page = append(page, image)
	}
	if err := rows.Err(); err != nil {
		return nil, classifyDBError(err)
	}
	return page, nil
}
