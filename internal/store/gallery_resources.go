package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/imgbed"
)

// PublicGalleryResource serves only authoritative local originals or current
// thumbnail versions. ImgBed originals are linked directly, never proxied here.
func (s *Store) PublicGalleryResource(ctx context.Context, publicID, filename string, head bool) (domain.GalleryResource, error) {
	var result domain.GalleryResource
	if !validPublicID(publicID) || !safeImagePath(publicID[:2]+"/"+publicID+"/"+filename) {
		return result, galleryNotFound()
	}
	ctx, cancel := context.WithTimeout(ctx, originalOperationBudget)
	defer cancel()
	release, err := s.storageGate.acquire(ctx, false)
	if err != nil {
		return result, err
	}
	defer release()
	dbCtx, dbCancel := s.operation(ctx)
	config, found, err := s.readStorageConfig(dbCtx)
	dbCancel()
	if err != nil {
		return result, err
	}
	if !found {
		return result, initializationRequired()
	}
	s.galleryGate.RLock()
	defer s.galleryGate.RUnlock()
	var id int64
	dbCtx, dbCancel = s.operation(ctx)
	err = s.db.QueryRowContext(dbCtx, `SELECT id FROM gallery WHERE public_id = ?`, publicID).Scan(&id)
	dbCancel()
	if errors.Is(err, sql.ErrNoRows) {
		return result, galleryNotFound()
	}
	if err != nil {
		return result, classifyDBError(err)
	}
	unlock := s.imageLocks.lock(fmt.Sprint(id))
	defer unlock()
	if strings.HasPrefix(filename, "original.") {
		if config.Mode != domain.StorageLocal {
			return result, galleryNotFound()
		}
		image, err := s.imageMetadata(ctx, "public_id", publicID)
		if err != nil {
			return result, err
		}
		if !localOriginalRef(image.Ref, image.MIME) || image.Ref != publicID[:2]+"/"+publicID+"/"+filename {
			return result, galleryNotFound()
		}
		backend := localBackend{files: s.files}
		result.MIME, result.Bytes = image.MIME, image.Bytes
		if head {
			err = backend.Verify(ctx, image.Ref, image.MIME, image.Bytes)
		} else {
			result.Data, err = backend.Read(ctx, image.Ref, image.MIME, image.Bytes)
		}
		return result, mapOriginalError(err)
	}
	var thumbPath, mime sql.NullString
	var size sql.NullInt64
	dbCtx, dbCancel = s.operation(ctx)
	err = s.db.QueryRowContext(dbCtx, `SELECT thumb_path, thumb_mime, thumb_bytes FROM gallery WHERE id = ? AND public_id = ?`, id, publicID).Scan(&thumbPath, &mime, &size)
	dbCancel()
	if errors.Is(err, sql.ErrNoRows) {
		return result, galleryNotFound()
	}
	if err != nil {
		return result, classifyDBError(err)
	}
	if size.Int64 <= 0 || !validThumbIdentity(publicID, thumbPath.String, mime.String) || path.Base(thumbPath.String) != filename {
		return result, galleryNotFound()
	}
	result.MIME, result.Bytes = mime.String, size.Int64
	if head {
		actual, statErr := s.files.stat(ctx, thumbPath.String)
		if statErr == nil {
			if actual != result.Bytes {
				return domain.GalleryResource{}, localStorageError(errors.New("thumbnail length mismatch"))
			}
			return result, nil
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return domain.GalleryResource{}, localStorageError(statErr)
		}
	}
	// Recovery may rotate the file path but the backup is bound to the exact
	// requested metadata version; it cannot substitute a re-enriched thumbnail.
	data, actualMIME, err := s.thumbnailContent(ctx, id)
	if err != nil {
		return domain.GalleryResource{}, err
	}
	result.MIME, result.Bytes = actualMIME, int64(len(data))
	if !head {
		result.Data = data
	}
	return result, nil
}

// galleryResourceURLs derives public links without reading or probing image bodies.
func galleryResourceURLs(item *domain.GalleryItem, config domain.StorageConfig, publicID, originalRef, mime string, size int64, thumbPath, thumbMIME string, thumbSize int64) {
	if !validPublicID(publicID) {
		return
	}
	prefix := "/images/" + publicID + "/"
	if item.Archived && size > 0 && validStoredMIME(mime) {
		var target string
		switch config.Mode {
		case domain.StorageLocal:
			if originalRef == publicID[:2]+"/"+publicID+"/original."+mustImageExtension(mime) {
				target = prefix + path.Base(originalRef)
			}
		case domain.StorageImgbed:
			if strings.HasSuffix(originalRef, "."+mustImageExtension(mime)) {
				target, _ = imgbed.PublicFileURL(config.ImgbedBaseURL, originalRef)
			}
		}
		if target != "" {
			item.ImageURL = &target
		}
	}
	if thumbSize > 0 && validThumbIdentity(publicID, thumbPath, thumbMIME) {
		target := prefix + path.Base(thumbPath)
		item.ThumbnailURL = &target
	}
}

func mustImageExtension(mime string) string {
	ext, _ := fileExtension(mime)
	return ext
}
