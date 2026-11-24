package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

// SaveGeneratedImage persists a valid original atomically by its execution output key.
func (s *Store) SaveGeneratedImage(ctx context.Context, insert domain.GalleryInsert) (domain.StoredImage, error) {
	if len(insert.Image) == 0 || insert.ImageMIME == nil || !validStoredMIME(*insert.ImageMIME) {
		return domain.StoredImage{}, apierror.Invalid("image", "a supported non-empty original image is required", "invalid_value")
	}
	stored, _, err := s.insertGallery(ctx, insert)
	return stored, err
}

// SaveDeliveryImage returns the authoritative original only for base64 delivery.
// A newly inserted output reuses the download; a deduplicated output reads its saved BLOB.
func (s *Store) SaveDeliveryImage(ctx context.Context, insert domain.GalleryInsert, includeOriginal bool) (domain.StoredImage, []byte, error) {
	if len(insert.Image) == 0 || insert.ImageMIME == nil || !validStoredMIME(*insert.ImageMIME) {
		return domain.StoredImage{}, nil, apierror.Invalid("image", "a supported non-empty original image is required", "invalid_value")
	}
	stored, reused, err := s.insertGallery(ctx, insert)
	if err != nil || !includeOriginal {
		return stored, nil, err
	}
	if !reused {
		return stored, insert.Image, nil
	}
	data, _, err := s.PublicImageContent(ctx, stored.PublicID)
	return stored, data, err
}

// InsertGallery shares the idempotent insertion boundary for seeds and ordinary rows.
func (s *Store) InsertGallery(ctx context.Context, insert domain.GalleryInsert) (int64, error) {
	stored, _, err := s.insertGallery(ctx, insert)
	return stored.ID, err
}

func (s *Store) insertGallery(ctx context.Context, insert domain.GalleryInsert) (domain.StoredImage, bool, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	if strings.TrimSpace(insert.OutputKey) == "" {
		return domain.StoredImage{}, false, apierror.Invalid("outputKey", "outputKey is required", "invalid_value")
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return domain.StoredImage{}, false, err
	}
	publicID := hex.EncodeToString(random[:])
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

	var stored domain.StoredImage
	var mime sql.NullString
	var byteCount sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO gallery (public_id, output_key, created_at, request_id, model, prompt, size_request, size_actual,
			account_id, account_name, source_url, source_mime, source_bytes,
			image, image_mime, image_bytes, archived, enrich_status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
		 ON CONFLICT(output_key) DO NOTHING
		 RETURNING id, public_id, image_mime, image_bytes`,
		publicID, insert.OutputKey, formatTime(s.now()), insert.RequestID, insert.Model, insert.Prompt, insert.SizeRequest,
		sizeActual, accountID, insert.AccountName, nullString(insert.SourceURL), sourceMime, sourceBytes,
		imageArg, mimeArg, bytesArg, boolToInt(image != nil),
	).Scan(&stored.ID, &stored.PublicID, &mime, &byteCount)
	reused := err == sql.ErrNoRows
	if reused {
		err = s.db.QueryRowContext(ctx, `SELECT id, public_id, image_mime, image_bytes FROM gallery WHERE output_key = ?`, insert.OutputKey).Scan(&stored.ID, &stored.PublicID, &mime, &byteCount)
	}
	if err != nil {
		return domain.StoredImage{}, false, classifyDBError(err)
	}
	stored.MIME, stored.Bytes = mime.String, byteCount.Int64
	return stored, reused, nil
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
		`SELECT enrich_status, source_url, image_mime, image_bytes, source_bytes FROM gallery WHERE id = ?`,
		id).Scan(&status, &sourceURL, &mime, &bytes, &sourceBytes)
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
	return source, nil
}

// SetImageMeasurement backfills best-effort URL measurements without clearing originals.
func (s *Store) SetImageMeasurement(ctx context.Context, id int64, measurement domain.Measurement) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var clauses []string
	var args []any
	if measurement.Size != nil {
		clauses = append(clauses, "size_actual = ?")
		args = append(args, fmt.Sprintf("%dx%d", measurement.Size.Width, measurement.Size.Height))
	}
	if measurement.Format != nil {
		mime := normalizeStoredMIME("image/" + *measurement.Format)
		if validStoredMIME(mime) {
			clauses = append(clauses, "source_mime = ?")
			args = append(args, mime)
		}
	}
	if len(clauses) == 0 {
		return nil
	}
	args = append(args, id)
	_, err := s.db.ExecContext(ctx, "UPDATE gallery SET "+strings.Join(clauses, ", ")+" WHERE id = ?", args...)
	return classifyDBError(err)
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
