package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const nowFormat = timeFormat

// ReadSettings loads and strictly validates the single settings row.
func (s *Store) ReadSettings(ctx context.Context) (domain.Settings, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var data string
	err := s.db.QueryRowContext(ctx, `SELECT data FROM settings WHERE id = 1`).Scan(&data)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.Settings{}, apierror.Coded(500, "settings are not initialized", "server_error", "invalid_settings")
		}
		return domain.Settings{}, classifyDBError(err)
	}

	dec := json.NewDecoder(strings.NewReader(data))
	dec.DisallowUnknownFields()
	var settings domain.Settings
	if err := dec.Decode(&settings); err != nil {
		return domain.Settings{}, apierror.Coded(500, "stored settings are invalid", "server_error", "invalid_settings")
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); err == nil {
		return domain.Settings{}, apierror.Coded(500, "stored settings are invalid", "server_error", "invalid_settings")
	}
	validated, err := domain.ValidateSettings(settings)
	if err != nil {
		return domain.Settings{}, err
	}
	return validated, nil
}

// WriteSettings validates and stores the complete settings structure.
func (s *Store) WriteSettings(ctx context.Context, settings domain.Settings) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	validated, err := domain.ValidateSettings(settings)
	if err != nil {
		return err
	}
	data, err := json.Marshal(validated)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
		string(data), s.now().UTC().Format(nowFormat),
	)
	return classifyDBError(err)
}
