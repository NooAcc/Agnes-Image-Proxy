package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

func (s *Store) CreateGenerationKey(ctx context.Context, name string) (domain.GenerationKey, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 128 || strings.ContainsFunc(name, unicode.IsControl) {
		return domain.GenerationKey{}, apierror.Invalid("name", "name must be 1–128 characters without control characters", "invalid_value")
	}
	publicID, salt := auth.NewGenerationKeyMaterial()
	key := domain.GenerationKey{PublicID: publicID, Salt: salt, Name: name, CreatedAt: s.now().UTC()}
	ctx, cancel := s.operation(ctx)
	defer cancel()
	err := s.db.QueryRowContext(ctx, `INSERT INTO generation_keys (public_id, secret_salt, name, created_at)
		VALUES (?, ?, ?, ?) RETURNING id`, key.PublicID, key.Salt, key.Name, formatTime(key.CreatedAt)).Scan(&key.ID)
	if err != nil {
		return domain.GenerationKey{}, classifyDBError(err)
	}
	return key, nil
}

func (s *Store) ListGenerationKeys(ctx context.Context) ([]domain.GenerationKey, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	rows, err := s.db.QueryContext(ctx, `SELECT id, public_id, name, created_at FROM generation_keys ORDER BY id DESC`)
	if err != nil {
		return nil, classifyDBError(err)
	}
	defer rows.Close()
	items := []domain.GenerationKey{}
	for rows.Next() {
		item, err := scanGenerationKey(rows)
		if err != nil {
			return nil, classifyDBError(err)
		}
		items = append(items, item)
	}
	return items, classifyDBError(rows.Err())
}

func (s *Store) GetGenerationKey(ctx context.Context, id int64) (domain.GenerationKey, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var key domain.GenerationKey
	var created string
	err := s.db.QueryRowContext(ctx, `SELECT id, public_id, name, created_at, secret_salt FROM generation_keys WHERE id = ?`, id).
		Scan(&key.ID, &key.PublicID, &key.Name, &created, &key.Salt)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.GenerationKey{}, generationKeyNotFound()
	}
	if err != nil {
		return domain.GenerationKey{}, classifyDBError(err)
	}
	key.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	return key, classifyDBError(err)
}

func (s *Store) RevokeGenerationKey(ctx context.Context, id int64) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	result, err := s.db.ExecContext(ctx, `DELETE FROM generation_keys WHERE id = ?`, id)
	if err != nil {
		return classifyDBError(err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return classifyDBError(err)
	}
	if n == 0 {
		return generationKeyNotFound()
	}
	return nil
}

// LookupGenerationKey returns the material required for verification and logging.
// An empty salt means the key was revoked or is unknown.
func (s *Store) LookupGenerationKey(ctx context.Context, publicID string) (domain.GenerationKey, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var key domain.GenerationKey
	err := s.db.QueryRowContext(ctx, `SELECT secret_salt, name FROM generation_keys WHERE public_id = ?`, publicID).Scan(&key.Salt, &key.Name)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.GenerationKey{}, nil
	}
	return key, classifyDBError(err)
}

func scanGenerationKey(row rowScanner) (domain.GenerationKey, error) {
	var key domain.GenerationKey
	var created string
	if err := row.Scan(&key.ID, &key.PublicID, &key.Name, &created); err != nil {
		return domain.GenerationKey{}, err
	}
	var err error
	key.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	return key, err
}

func generationKeyNotFound() error {
	return apierror.Coded(404, "generation key not found", "invalid_request_error", "generation_key_not_found")
}
