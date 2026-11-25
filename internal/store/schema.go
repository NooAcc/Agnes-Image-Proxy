package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const (
	metaApplication = "agnes-go"
	metaVersion     = "4"
)

// appTables lists the tables this application owns. Reset only ever touches
// these names.
var appTables = []string{
	"request_logs",
	"model_usage_daily",
	"gallery",
	"accounts",
	"settings",
	"auth_state",
	"storage_config",
	"app_meta",
}

var requiredColumns = map[string][]string{
	"app_meta": {"key", "value"},
	"accounts": {
		"id", "name", "api_key", "enabled", "status", "cooldown_until", "fail_count",
		"use_seq", "last_used_at", "upstream_requests", "upstream_images", "created_at",
	},
	"settings":   {"id", "data", "updated_at"},
	"auth_state": {"id", "session_epoch"},
	"storage_config": {
		"id", "mode", "imgbed_base_url", "imgbed_token", "created_at", "updated_at",
	},
	"request_logs": {
		"id", "request_id", "ts", "category", "stage", "endpoint", "path", "model",
		"status", "ok", "requested", "images", "failed", "duration_ms",
		"size_request", "size_actual", "attempts", "partial", "delivery_failures",
	},
	"model_usage_daily": {"day", "model", "requests", "successes", "partials", "failures", "images"},
	"gallery": {
		"id", "public_id", "output_key", "created_at", "request_id", "model", "prompt", "size_request", "size_actual",
		"account_id", "account_name", "source_url", "source_mime", "source_bytes",
		"original_ref", "image_mime", "image_bytes", "archived", "thumb", "thumb_path", "thumb_mime",
		"thumb_bytes", "nsfw_tag", "nsfw_scores", "enrich_status", "enrich_error", "enriched_at",
	},
}

var schemaStatements = []string{
	`CREATE TABLE app_meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,
	`CREATE TABLE accounts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		api_key TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		status TEXT NOT NULL DEFAULT 'healthy',
		cooldown_until TEXT,
		fail_count INTEGER NOT NULL DEFAULT 0,
		use_seq INTEGER NOT NULL DEFAULT 0,
		last_used_at TEXT,
		upstream_requests INTEGER NOT NULL DEFAULT 0,
		upstream_images INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX idx_accounts_selection ON accounts (enabled, use_seq, id)`,
	`CREATE TABLE settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		data TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE auth_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		session_epoch INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE TABLE storage_config (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		mode TEXT NOT NULL CHECK (mode IN ('local', 'imgbed')),
		imgbed_base_url TEXT,
		imgbed_token TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		CHECK (
			(mode = 'local' AND imgbed_base_url IS NULL AND imgbed_token IS NULL) OR
			(mode = 'imgbed' AND imgbed_base_url IS NOT NULL AND imgbed_token IS NOT NULL)
		)
	)`,
	`CREATE TRIGGER storage_config_mode_immutable
		BEFORE UPDATE OF mode ON storage_config
		WHEN OLD.mode IS NOT NEW.mode
		BEGIN
			SELECT RAISE(ABORT, 'storage mode is immutable');
		END`,
	`CREATE TABLE request_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		request_id TEXT NOT NULL,
		ts TEXT NOT NULL,
		category TEXT NOT NULL,
		stage TEXT NOT NULL,
		endpoint TEXT NOT NULL DEFAULT '',
		path TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '',
		status INTEGER NOT NULL,
		ok INTEGER NOT NULL,
		requested INTEGER NOT NULL DEFAULT 0,
		images INTEGER NOT NULL DEFAULT 0,
		failed INTEGER NOT NULL DEFAULT 0,
		duration_ms INTEGER NOT NULL DEFAULT 0,
		size_request TEXT,
		size_actual TEXT,
		attempts TEXT NOT NULL DEFAULT '[]',
		partial INTEGER NOT NULL,
		delivery_failures TEXT NOT NULL
	)`,
	`CREATE INDEX idx_request_logs_category ON request_logs (category, id)`,
	`CREATE INDEX idx_request_logs_ts ON request_logs (ts)`,
	`CREATE TABLE model_usage_daily (
		day TEXT NOT NULL,
		model TEXT NOT NULL,
		requests INTEGER NOT NULL DEFAULT 0,
		successes INTEGER NOT NULL DEFAULT 0,
		partials INTEGER NOT NULL DEFAULT 0,
		failures INTEGER NOT NULL DEFAULT 0,
		images INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (day, model)
	)`,
	`CREATE INDEX idx_model_usage_day ON model_usage_daily (day)`,
	`CREATE TABLE gallery (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		public_id TEXT NOT NULL UNIQUE,
		output_key TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL,
		request_id TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '',
		prompt TEXT NOT NULL DEFAULT '',
		size_request TEXT NOT NULL DEFAULT '',
		size_actual TEXT,
		account_id INTEGER,
		account_name TEXT NOT NULL DEFAULT '',
		source_url TEXT,
		source_mime TEXT,
		source_bytes INTEGER,
		original_ref TEXT,
		image_mime TEXT,
		image_bytes INTEGER,
		archived INTEGER NOT NULL DEFAULT 0,
		thumb BLOB,
		thumb_path TEXT,
		thumb_mime TEXT,
		thumb_bytes INTEGER,
		nsfw_tag TEXT,
		nsfw_scores TEXT,
		enrich_status TEXT NOT NULL DEFAULT 'pending',
		enrich_error TEXT,
		enriched_at TEXT
	)`,
	`CREATE INDEX idx_gallery_enrich ON gallery (enrich_status, id)`,
	`CREATE INDEX idx_gallery_created ON gallery (created_at)`,
}

// EnsureSchema creates the new-contract schema in an empty database or
// verifies an existing one. It never mutates an incompatible database.
func (s *Store) EnsureSchema(ctx context.Context) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return classifyDBError(err)
	}
	defer func() { _ = tx.Rollback() }()

	var count int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'`,
	).Scan(&count); err != nil {
		return classifyDBError(err)
	}

	if count == 0 {
		if err := createSchema(ctx, tx, s.now); err != nil {
			return err
		}
		return classifyDBError(tx.Commit())
	}

	if err := verifySchema(ctx, tx); err != nil {
		return err
	}
	return classifyDBError(tx.Commit())
}

func createSchema(ctx context.Context, tx *sql.Tx, now func() time.Time) error {
	for _, stmt := range schemaStatements {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return classifyDBError(err)
		}
	}
	generation, err := randomFileName("")
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO app_meta (key, value) VALUES ('application', ?), ('schema', ?), ('gallery_generation', ?)`,
		metaApplication, metaVersion, generation,
	); err != nil {
		return classifyDBError(err)
	}
	settings := domain.DefaultSettings()
	data, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)`,
		string(data), now().UTC().Format(nowFormat),
	); err != nil {
		return classifyDBError(err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO auth_state (id, session_epoch) VALUES (1, 1)`,
	); err != nil {
		return classifyDBError(err)
	}
	return nil
}

func verifySchema(ctx context.Context, tx *sql.Tx) error {
	var application, version string
	if err := tx.QueryRowContext(ctx, `SELECT value FROM app_meta WHERE key='application'`).Scan(&application); err != nil {
		return incompatibleSchema()
	}
	if err := tx.QueryRowContext(ctx, `SELECT value FROM app_meta WHERE key='schema'`).Scan(&version); err != nil {
		return incompatibleSchema()
	}
	if application != metaApplication || version != metaVersion {
		return incompatibleSchema()
	}
	var generation string
	if err := tx.QueryRowContext(ctx, `SELECT value FROM app_meta WHERE key='gallery_generation'`).Scan(&generation); err != nil || !validPublicID(generation) {
		return incompatibleSchema()
	}

	for table, columns := range requiredColumns {
		found, err := tableColumns(ctx, tx, table)
		if err != nil {
			return err
		}
		if found == nil {
			return incompatibleSchema()
		}
		for _, want := range columns {
			if !found[want] {
				return incompatibleSchema()
			}
		}
	}
	var trigger string
	if err := tx.QueryRowContext(ctx,
		`SELECT name FROM sqlite_master WHERE type='trigger' AND name='storage_config_mode_immutable'`,
	).Scan(&trigger); err != nil || trigger == "" {
		return incompatibleSchema()
	}
	return nil
}

func tableColumns(ctx context.Context, tx *sql.Tx, table string) (map[string]bool, error) {
	// table comes from the fixed requiredColumns whitelist, never user input.
	rows, err := tx.QueryContext(ctx, fmt.Sprintf("SELECT name FROM pragma_table_info('%s')", table))
	if err != nil {
		return nil, classifyDBError(err)
	}
	defer rows.Close()

	found := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, classifyDBError(err)
		}
		found[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, classifyDBError(err)
	}
	if len(found) == 0 {
		return nil, nil
	}
	return found, nil
}

// ResetSchema drops only the application's own tables and recreates an empty
// schema. It requires explicit confirmation. On schema 4 with imgbed storage it
// first removes every registered remote original; a failure keeps both the
// credentials and the remaining rows.
func (s *Store) ResetSchema(ctx context.Context, confirmed bool) error {
	if !confirmed {
		return apierror.Coded(400, "reset requires explicit confirmation", "invalid_request_error", "reset_not_confirmed")
	}
	version, err := s.schemaVersion(ctx)
	if err != nil {
		return err
	}
	if version != metaVersion {
		// Legacy schemas are rebuilt without interpreting their original data.
		s.galleryGate.Lock()
		defer s.galleryGate.Unlock()
		return s.rebuildSchemaLocked(ctx)
	}

	storageRelease, err := s.storageGate.acquire(ctx, true)
	if err != nil {
		return err
	}
	defer storageRelease()
	s.galleryGate.Lock()
	defer s.galleryGate.Unlock()

	dbCtx, cancel := s.operation(ctx)
	config, found, err := s.readStorageConfig(dbCtx)
	cancel()
	if err != nil {
		// A corrupted schema 4 configuration must never be skipped as legacy:
		// credentials may still protect registered remote originals.
		return err
	}
	if found {
		backend, err := s.backendFor(config)
		if err != nil {
			return err
		}
		if err := s.clearGalleryLocked(ctx, backend); err != nil {
			return err
		}
	} else {
		var count int
		dbCtx, cancel = s.operation(ctx)
		err = s.db.QueryRowContext(dbCtx, `SELECT COUNT(*) FROM gallery`).Scan(&count)
		cancel()
		if err != nil {
			return classifyDBError(err)
		}
		if count > 0 {
			return apierror.Coded(500, "gallery rows exist without storage configuration", "server_error", "invalid_storage_config")
		}
	}
	return s.rebuildSchemaLocked(ctx)
}

func (s *Store) schemaVersion(ctx context.Context) (string, error) {
	dbCtx, cancel := s.operation(ctx)
	defer cancel()
	var version string
	err := s.db.QueryRowContext(dbCtx, `SELECT value FROM app_meta WHERE key='schema'`).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) || err == nil && version == "" {
		return "", nil
	}
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		// A missing app_meta table is a legacy database; other failures are real.
		if strings.Contains(err.Error(), "no such table") {
			return "", nil
		}
		return "", classifyDBError(err)
	}
	return version, nil
}

func (s *Store) rebuildSchemaLocked(ctx context.Context) error {
	dbCtx, cancel := s.operation(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(dbCtx, nil)
	if err != nil {
		return classifyDBError(err)
	}
	defer tx.Rollback()
	for _, table := range appTables {
		if _, err := tx.ExecContext(dbCtx, "DROP TABLE IF EXISTS "+table); err != nil {
			return classifyDBError(err)
		}
	}
	if err := createSchema(dbCtx, tx, s.now); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return classifyDBError(err)
	}
	return localStorageError(s.files.clear())
}

func incompatibleSchema() error {
	return apierror.Coded(500,
		"database schema is not compatible with this application; create an empty database or run reset-db",
		"server_error", "incompatible_schema")
}

func classifyDBError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return err
	}
	return unavailable()
}
