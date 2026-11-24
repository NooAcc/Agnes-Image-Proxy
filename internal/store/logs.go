package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const (
	defaultLogLimit = 50
	maxLimit        = 100
)

// RecordRequest writes one log row and, for effective image requests, the
// same-transaction daily model usage.
func (s *Store) RecordRequest(ctx context.Context, log domain.RequestLog) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	normalized, err := normalizeRequestLog(log, s.now().UTC())
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return classifyDBError(err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := insertRequestLog(ctx, tx, normalized); err != nil {
		return err
	}
	if normalized.Category == "request" && normalized.Model != "" && normalized.Stage != "parse" {
		successes := int64(0)
		partials := int64(0)
		failures := int64(0)
		if normalized.Images > 0 {
			successes = 1
		} else {
			failures = 1
		}
		if normalized.Images > 0 && normalized.Partial {
			partials = 1
		}
		day := normalized.TS.UTC().Format("2006-01-02")
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO model_usage_daily (day, model, requests, successes, partials, failures, images)
			 VALUES (?, ?, 1, ?, ?, ?, ?)
			 ON CONFLICT(day, model) DO UPDATE SET
				requests = requests + 1,
				successes = successes + excluded.successes,
				partials = partials + excluded.partials,
				failures = failures + excluded.failures,
				images = images + excluded.images`,
			day, normalized.Model, successes, partials, failures, normalized.Images,
		); err != nil {
			return classifyDBError(err)
		}
	}
	return classifyDBError(tx.Commit())
}

// RecordEnrichment writes an enrichment log without touching usage.
func (s *Store) RecordEnrichment(ctx context.Context, log domain.RequestLog) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	log.Category = "enrich"
	if log.RequestID == "" && log.Stage == "" && log.Model == "" && len(log.Attempts) == 0 && log.Images == 0 && log.Failed == 0 {
		return nil
	}
	normalized, err := normalizeRequestLog(log, s.now().UTC())
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return classifyDBError(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertRequestLog(ctx, tx, normalized); err != nil {
		return err
	}
	return classifyDBError(tx.Commit())
}

func normalizeRequestLog(log domain.RequestLog, now time.Time) (domain.RequestLog, error) {
	if log.Category == "" {
		log.Category = "request"
	}
	if log.Category != "request" && log.Category != "enrich" {
		return domain.RequestLog{}, apierror.Invalid("category", "category must be request or enrich", "invalid_value")
	}
	if log.TS.IsZero() {
		log.TS = now
	}
	if log.Requested < 0 {
		log.Requested = 0
	}
	if log.Images < 0 {
		log.Images = 0
	}
	// Failed counts subrequests, while Images counts outputs. One successful
	// subrequest may return several images; do not subtract unlike units.
	if log.Images == 0 {
		log.Failed = log.Requested
	} else {
		if log.Failed < 0 {
			log.Failed = 0
		}
		if log.Failed > log.Requested {
			log.Failed = log.Requested
		}
	}
	log.OK = log.Images > 0
	log.Partial = log.OK && (log.Partial || log.Failed > 0 || len(log.DeliveryFailures) > 0)
	if log.DeliveryFailures == nil {
		log.DeliveryFailures = []domain.DeliveryFailure{}
	}
	if log.Attempts == nil {
		log.Attempts = []domain.Attempt{}
	}
	return log, nil
}

func insertRequestLog(ctx context.Context, tx *sql.Tx, log domain.RequestLog) error {
	attempts, err := json.Marshal(log.Attempts)
	if err != nil {
		return err
	}
	if string(attempts) == "null" {
		attempts = []byte("[]")
	}
	deliveryFailures, err := json.Marshal(log.DeliveryFailures)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO request_logs (request_id, ts, category, stage, endpoint, path, model, status, ok,
			requested, images, failed, duration_ms, size_request, size_actual, attempts, partial, delivery_failures)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		log.RequestID, formatTime(log.TS), log.Category, log.Stage, log.Endpoint, log.Path, log.Model,
		log.Status, boolToInt(log.OK), log.Requested, log.Images, log.Failed, log.DurationMS,
		nullString(log.SizeRequest), nullString(log.SizeActual), string(attempts), boolToInt(log.Partial), string(deliveryFailures),
	)
	return classifyDBError(err)
}

// ListLogs returns logs newest-first with keyset pagination and an optional
// category filter.
func (s *Store) ListLogs(ctx context.Context, query domain.CursorQuery) (domain.Page[domain.RequestLog], error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	category := strings.TrimSpace(query.Category)
	if category != "" && category != "request" && category != "enrich" {
		return domain.Page[domain.RequestLog]{}, apierror.Invalid("category", "category must be request or enrich", "invalid_value")
	}
	limit := normalizeLimit(query.Limit, defaultLogLimit)
	if query.Before != nil && *query.Before < 0 {
		return domain.Page[domain.RequestLog]{}, apierror.Invalid("before", "before must be a positive cursor", "invalid_value")
	}

	sqlQuery := `SELECT id, request_id, ts, category, stage, endpoint, path, model, status, ok,
		requested, images, failed, duration_ms, size_request, size_actual, attempts, partial, delivery_failures
		FROM request_logs WHERE 1=1`
	var args []any
	if query.Before != nil {
		sqlQuery += " AND id < ?"
		args = append(args, *query.Before)
	}
	if category != "" {
		sqlQuery += " AND category = ?"
		args = append(args, category)
	}
	sqlQuery += " ORDER BY id DESC LIMIT ?"
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		return domain.Page[domain.RequestLog]{}, classifyDBError(err)
	}
	defer rows.Close()

	items := make([]domain.RequestLog, 0, limit)
	for rows.Next() {
		item, err := scanRequestLog(rows)
		if err != nil {
			return domain.Page[domain.RequestLog]{}, classifyDBError(err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return domain.Page[domain.RequestLog]{}, classifyDBError(err)
	}

	var nextBefore *int64
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1].ID
		nextBefore = &last
	}
	return domain.Page[domain.RequestLog]{Items: items, NextBefore: nextBefore}, nil
}

func scanRequestLog(row rowScanner) (domain.RequestLog, error) {
	var (
		item             domain.RequestLog
		ts               string
		ok               int
		sizeReq          sql.NullString
		sizeAct          sql.NullString
		attempt          string
		partial          int
		deliveryFailures string
	)
	if err := row.Scan(&item.ID, &item.RequestID, &ts, &item.Category, &item.Stage, &item.Endpoint,
		&item.Path, &item.Model, &item.Status, &ok, &item.Requested, &item.Images, &item.Failed,
		&item.DurationMS, &sizeReq, &sizeAct, &attempt, &partial, &deliveryFailures); err != nil {
		return domain.RequestLog{}, err
	}
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return domain.RequestLog{}, err
	}
	item.TS = parsed.UTC()
	item.OK = ok != 0
	item.Partial = partial != 0
	item.DeliveryFailures = []domain.DeliveryFailure{}
	if err := json.Unmarshal([]byte(deliveryFailures), &item.DeliveryFailures); err != nil {
		return domain.RequestLog{}, err
	}
	if sizeReq.Valid {
		item.SizeRequest = &sizeReq.String
	}
	if sizeAct.Valid {
		item.SizeActual = &sizeAct.String
	}
	item.Attempts = []domain.Attempt{}
	if strings.TrimSpace(attempt) != "" {
		if err := json.Unmarshal([]byte(attempt), &item.Attempts); err != nil {
			return domain.RequestLog{}, err
		}
	}
	return item, nil
}

// ClearLogs deletes every log row; usage is intentionally kept.
func (s *Store) ClearLogs(ctx context.Context) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	_, err := s.db.ExecContext(ctx, `DELETE FROM request_logs`)
	return classifyDBError(err)
}

func normalizeLimit(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	if value > maxLimit {
		return maxLimit
	}
	return value
}

func nullString(value *string) any {
	if value == nil || *value == "" {
		return nil
	}
	return *value
}

func isNotFound(err error) bool {
	var apiErr *apierror.Error
	return errors.As(err, &apiErr) && apiErr.Status == 404
}
