package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const (
	defaultGalleryLimit = 24
	defaultPendingLimit = 20
	maxPendingLimit     = 100
)

var galleryTags = map[string]bool{
	"safe": true, "drawing": true, "sexy": true, "porn": true, "hentai": true, "unclassified": true,
}

// InsertGallery stores one generated image row. Unknown image types are never
// persisted as blobs.
func (s *Store) InsertGallery(ctx context.Context, insert domain.GalleryInsert) (int64, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	imageMIME := ""
	if insert.ImageMIME != nil {
		imageMIME = normalizeStoredMIME(*insert.ImageMIME)
	}
	image := insert.Image
	if len(image) == 0 || !validStoredMIME(imageMIME) {
		image = nil
		imageMIME = ""
	}

	var (
		imageArg    any
		bytesArg    any
		mimeArg     any
		accountID   any
		sourceMime  any
		sourceBytes any
		sizeActual  any
	)
	if image != nil {
		imageArg = image
		bytesArg = len(image)
		mimeArg = imageMIME
	}
	if insert.AccountID != nil {
		accountID = *insert.AccountID
	}
	if insert.SourceMIME != nil {
		sourceMime = nullString(insert.SourceMIME)
	}
	if insert.SourceBytes != nil {
		sourceBytes = *insert.SourceBytes
	}
	if insert.SizeActual != nil && *insert.SizeActual != "" {
		sizeActual = *insert.SizeActual
	}

	var id int64
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO gallery (created_at, request_id, model, prompt, size_request, size_actual,
			account_id, account_name, source_url, source_mime, source_bytes,
			image, image_mime, image_bytes, archived, enrich_status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
		 RETURNING id`,
		formatTime(s.now()), insert.RequestID, insert.Model, insert.Prompt, insert.SizeRequest,
		sizeActual, accountID, insert.AccountName, nullString(insert.SourceURL), sourceMime, sourceBytes,
		imageArg, mimeArg, bytesArg, boolToInt(image != nil),
	).Scan(&id)
	if err != nil {
		return 0, classifyDBError(err)
	}
	return id, nil
}

// ListGallery returns gallery summaries newest-first with tag filtering.
func (s *Store) ListGallery(ctx context.Context, query domain.CursorQuery) (domain.Page[domain.GalleryItem], error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	tag := strings.TrimSpace(query.Tag)
	if tag != "" && !galleryTags[tag] {
		return domain.Page[domain.GalleryItem]{}, apierror.Invalid("tag", "unknown nsfw tag", "invalid_value")
	}
	if query.Before != nil && *query.Before < 0 {
		return domain.Page[domain.GalleryItem]{}, apierror.Invalid("before", "before must be a positive cursor", "invalid_value")
	}
	limit := normalizeLimit(query.Limit, defaultGalleryLimit)

	sqlQuery := `SELECT id, created_at, request_id, model, prompt, size_request, size_actual,
		account_name, nsfw_tag, nsfw_scores, enrich_status, source_url, archived
		FROM gallery WHERE 1=1`
	var args []any
	if query.Before != nil {
		sqlQuery += " AND id < ?"
		args = append(args, *query.Before)
	}
	switch tag {
	case "":
	case "unclassified":
		sqlQuery += " AND nsfw_tag IS NULL"
	default:
		sqlQuery += " AND nsfw_tag = ?"
		args = append(args, tag)
	}
	sqlQuery += " ORDER BY id DESC LIMIT ?"
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		return domain.Page[domain.GalleryItem]{}, classifyDBError(err)
	}
	defer rows.Close()

	items := make([]domain.GalleryItem, 0, limit)
	for rows.Next() {
		item, err := scanGalleryItem(rows)
		if err != nil {
			return domain.Page[domain.GalleryItem]{}, classifyDBError(err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return domain.Page[domain.GalleryItem]{}, classifyDBError(err)
	}

	var nextBefore *int64
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1].ID
		nextBefore = &last
	}
	return domain.Page[domain.GalleryItem]{Items: items, NextBefore: nextBefore}, nil
}

func scanGalleryItem(row rowScanner) (domain.GalleryItem, error) {
	var (
		item      domain.GalleryItem
		createdAt string
		sizeReq   string
		sizeAct   sql.NullString
		tag       sql.NullString
		scores    sql.NullString
		source    sql.NullString
		archived  int
	)
	if err := row.Scan(&item.ID, &createdAt, &item.RequestID, &item.Model, &item.Prompt, &sizeReq,
		&sizeAct, &item.AccountName, &tag, &scores, &item.EnrichStatus, &source, &archived); err != nil {
		return domain.GalleryItem{}, err
	}
	parsed, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return domain.GalleryItem{}, err
	}
	item.CreatedAt = parsed.UTC()
	item.Size = sizeReq
	if sizeAct.Valid && sizeAct.String != "" {
		item.Size = sizeAct.String
	}
	if tag.Valid {
		item.Tag = tag.String
	}
	if scores.Valid && strings.TrimSpace(scores.String) != "" {
		var decoded domain.NSFWScores
		if err := json.Unmarshal([]byte(scores.String), &decoded); err != nil {
			return domain.GalleryItem{}, err
		}
		item.NSFWScores = &decoded
	}
	if source.Valid {
		item.SourceURL = &source.String
	}
	item.Archived = archived != 0
	return item, nil
}

// GalleryContent returns original or thumbnail bytes.
func (s *Store) GalleryContent(ctx context.Context, id int64, thumbnail bool) ([]byte, string, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	query := `SELECT image, image_mime FROM gallery WHERE id = ?`
	if thumbnail {
		query = `SELECT thumb, thumb_mime FROM gallery WHERE id = ?`
	}
	var (
		data []byte
		mime sql.NullString
	)
	err := s.db.QueryRowContext(ctx, query, id).Scan(&data, &mime)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, "", galleryNotFound()
		}
		return nil, "", classifyDBError(err)
	}
	if len(data) == 0 || !mime.Valid || mime.String == "" {
		return nil, "", galleryNotFound()
	}
	return data, mime.String, nil
}

// GallerySources loads enrichment metadata for the given ids in input order.
func (s *Store) GallerySources(ctx context.Context, ids []int64) ([]domain.GallerySource, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	if len(ids) == 0 {
		return []domain.GallerySource{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, source_url, image_mime, image_bytes, source_bytes FROM gallery WHERE id IN (`+placeholders+`)`,
		args...)
	if err != nil {
		return nil, classifyDBError(err)
	}
	defer rows.Close()

	byID := make(map[int64]domain.GallerySource)
	for rows.Next() {
		source, err := scanGallerySource(rows)
		if err != nil {
			return nil, classifyDBError(err)
		}
		byID[source.ID] = source
	}
	if err := rows.Err(); err != nil {
		return nil, classifyDBError(err)
	}

	out := make([]domain.GallerySource, 0, len(ids))
	for _, id := range ids {
		if source, ok := byID[id]; ok {
			out = append(out, source)
		}
	}
	return out, nil
}

// PendingEnrichment walks pending or failed rows newest-first.
func (s *Store) PendingEnrichment(ctx context.Context, before *int64, limit int) ([]domain.GallerySource, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	if before != nil && *before < 0 {
		return nil, apierror.Invalid("before", "before must be a positive cursor", "invalid_value")
	}
	if limit <= 0 {
		limit = defaultPendingLimit
	}
	if limit > maxPendingLimit {
		limit = maxPendingLimit
	}
	query := `SELECT id, source_url, image_mime, image_bytes, source_bytes FROM gallery
		WHERE enrich_status IN ('pending', 'failed')`
	var args []any
	if before != nil {
		query += " AND id < ?"
		args = append(args, *before)
	}
	query += " ORDER BY id DESC LIMIT ?"
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, classifyDBError(err)
	}
	defer rows.Close()

	out := make([]domain.GallerySource, 0, limit)
	for rows.Next() {
		source, err := scanGallerySource(rows)
		if err != nil {
			return nil, classifyDBError(err)
		}
		out = append(out, source)
	}
	if err := rows.Err(); err != nil {
		return nil, classifyDBError(err)
	}
	return out, nil
}

// GalleryEnrichState re-reads one row's enrichment status and source metadata
// under the backfill pass; missing rows report found=false.
func (s *Store) GalleryEnrichState(ctx context.Context, id int64) (string, domain.GallerySource, bool, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var (
		status      string
		source      domain.GallerySource
		sourceURL   sql.NullString
		mime        sql.NullString
		bytes       sql.NullInt64
		sourceBytes sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT enrich_status, source_url, image_mime, image_bytes, source_bytes,
			CASE WHEN image_bytes <= 52428800 THEN image ELSE NULL END FROM gallery WHERE id = ?`,
		id).Scan(&status, &sourceURL, &mime, &bytes, &sourceBytes, &source.Data)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", domain.GallerySource{}, false, nil
		}
		return "", domain.GallerySource{}, false, classifyDBError(err)
	}
	source.ID = id
	if sourceURL.Valid {
		source.SourceURL = &sourceURL.String
	}
	if mime.Valid {
		source.MIME = mime.String
	}
	if bytes.Valid {
		source.Bytes = bytes.Int64
	}
	if sourceBytes.Valid {
		source.SourceBytes = sourceBytes.Int64
	}
	source.HasImage = bytes.Valid && bytes.Int64 > 0 && mime.Valid && validStoredMIME(mime.String)
	return status, source, true, nil
}

func scanGallerySource(row rowScanner) (domain.GallerySource, error) {
	var (
		source      domain.GallerySource
		sourceURL   sql.NullString
		mime        sql.NullString
		bytes       sql.NullInt64
		sourceBytes sql.NullInt64
	)
	if err := row.Scan(&source.ID, &sourceURL, &mime, &bytes, &sourceBytes); err != nil {
		return domain.GallerySource{}, err
	}
	if sourceURL.Valid {
		source.SourceURL = &sourceURL.String
	}
	if mime.Valid {
		source.MIME = mime.String
	}
	if bytes.Valid {
		source.Bytes = bytes.Int64
	}
	if sourceBytes.Valid {
		source.SourceBytes = sourceBytes.Int64
	}
	source.HasImage = bytes.Valid && bytes.Int64 > 0 && mime.Valid && validStoredMIME(mime.String)
	return source, nil
}

// SetEnrichment updates thumbnail, tag and status. Missing rows are a no-op.
func (s *Store) SetEnrichment(ctx context.Context, id int64, write domain.EnrichmentWrite) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	status := strings.TrimSpace(write.Status)
	if status != "success" && status != "failed" && status != "pending" {
		return apierror.Invalid("status", "enrichment status must be success, failed or pending", "invalid_value")
	}
	at := write.At
	if at.IsZero() {
		at = s.now().UTC()
	}

	var tag any
	var scores any
	if status == "success" && write.Tag != "" {
		tag = write.Tag
	}
	if status == "success" && write.Scores != nil {
		encoded, err := json.Marshal(write.Scores)
		if err != nil {
			return err
		}
		scores = string(encoded)
	}

	setClauses := []string{
		"enrich_status = ?", "enrich_error = ?", "enriched_at = ?", "nsfw_tag = ?", "nsfw_scores = ?",
	}
	args := []any{status, nullString(write.Error), formatTime(at), tag, scores}

	if len(write.Thumb) > 0 && validStoredMIME(normalizeStoredMIME(write.ThumbMIME)) {
		setClauses = append(setClauses, "thumb = ?", "thumb_mime = ?", "thumb_bytes = ?")
		args = append(args, write.Thumb, normalizeStoredMIME(write.ThumbMIME), len(write.Thumb))
	}
	args = append(args, id)

	_, err := s.db.ExecContext(ctx,
		"UPDATE gallery SET "+strings.Join(setClauses, ", ")+" WHERE id = ?", args...)
	return classifyDBError(err)
}

// DeleteGallery removes one row.
func (s *Store) DeleteGallery(ctx context.Context, id int64) (bool, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	result, err := s.db.ExecContext(ctx, `DELETE FROM gallery WHERE id = ?`, id)
	if err != nil {
		return false, classifyDBError(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, classifyDBError(err)
	}
	return affected > 0, nil
}

// ClearGallery removes every gallery row.
func (s *Store) ClearGallery(ctx context.Context) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	_, err := s.db.ExecContext(ctx, `DELETE FROM gallery`)
	return classifyDBError(err)
}

func galleryNotFound() error {
	return apierror.Coded(404, "image content not found", "invalid_request_error", "not_found")
}

func normalizeStoredMIME(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
	if value == "image/jpg" {
		return "image/jpeg"
	}
	return value
}

func validStoredMIME(value string) bool {
	switch normalizeStoredMIME(value) {
	case "image/png", "image/jpeg", "image/webp":
		return true
	}
	return false
}
