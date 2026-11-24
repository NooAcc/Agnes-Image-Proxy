package store

import (
	"context"
	"database/sql"
	"fmt"
)

// SessionEpoch returns the persisted revocation epoch.
func (s *Store) SessionEpoch(ctx context.Context) (int64, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var epoch int64
	err := s.db.QueryRowContext(ctx, `SELECT session_epoch FROM auth_state WHERE id = 1`).Scan(&epoch)
	if err == sql.ErrNoRows {
		return 0, fmt.Errorf("auth_state row is missing")
	}
	if err != nil {
		return 0, classifyDBError(err)
	}
	return epoch, nil
}

// BumpSessionEpoch revokes all sessions and returns the new epoch.
func (s *Store) BumpSessionEpoch(ctx context.Context) (int64, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var epoch int64
	err := s.db.QueryRowContext(ctx,
		`UPDATE auth_state SET session_epoch = session_epoch + 1 WHERE id = 1 RETURNING session_epoch`).Scan(&epoch)
	if err == sql.ErrNoRows {
		return 0, fmt.Errorf("auth_state row is missing")
	}
	if err != nil {
		return 0, classifyDBError(err)
	}
	return epoch, nil
}
