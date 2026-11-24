package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// timeFormat keeps fixed-width nanosecond precision so SQL string comparisons
// (cooldowns, ranges) stay lexicographically correct. The value is valid
// RFC3339 and parses with time.RFC3339Nano.
const timeFormat = "2006-01-02T15:04:05.000000000Z"

func formatTime(t time.Time) string { return t.UTC().Format(timeFormat) }

func parseNullTime(value sql.NullString) (*time.Time, error) {
	if !value.Valid || value.String == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value.String)
	if err != nil {
		return nil, err
	}
	utc := parsed.UTC()
	return &utc, nil
}

// ListAccounts returns every account ordered by creation id.
func (s *Store) ListAccounts(ctx context.Context) ([]domain.AccountSummary, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	rows, err := s.db.QueryContext(ctx, accountSummaryColumns+` ORDER BY id ASC`)
	if err != nil {
		return nil, classifyDBError(err)
	}
	defer rows.Close()

	now := s.now().UTC()
	out := make([]domain.AccountSummary, 0)
	for rows.Next() {
		summary, err := scanAccountSummary(rows, now)
		if err != nil {
			return nil, classifyDBError(err)
		}
		out = append(out, summary)
	}
	if err := rows.Err(); err != nil {
		return nil, classifyDBError(err)
	}
	return out, nil
}

// GetAccount loads one account including its upstream key.
func (s *Store) GetAccount(ctx context.Context, id int64) (domain.Account, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	row := s.db.QueryRowContext(ctx, `SELECT id, name, api_key, enabled, status, cooldown_until, fail_count,
		last_used_at, upstream_requests, upstream_images, created_at FROM accounts WHERE id = ?`, id)
	account, err := scanAccount(row, s.now().UTC())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.Account{}, accountNotFound()
		}
		return domain.Account{}, classifyDBError(err)
	}
	return account, nil
}

// CreateAccount inserts a healthy account and returns its masked summary.
func (s *Store) CreateAccount(ctx context.Context, name, apiKey string) (domain.AccountSummary, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	name, apiKey, err := validateAccountFields(name, apiKey, true)
	if err != nil {
		return domain.AccountSummary{}, err
	}
	now := s.now().UTC()
	var id int64
	err = s.db.QueryRowContext(ctx,
		`INSERT INTO accounts (name, api_key, enabled, status, fail_count, use_seq, upstream_requests, upstream_images, created_at)
		 VALUES (?, ?, 1, 'healthy', 0, 0, 0, 0, ?) RETURNING id`,
		name, apiKey, formatTime(now),
	).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return domain.AccountSummary{}, apierror.Coded(409, "account name already exists", "invalid_request_error", "account_name_taken")
		}
		return domain.AccountSummary{}, classifyDBError(err)
	}
	return s.accountSummary(ctx, id)
}

// UpdateAccount applies a partial update. An empty APIKey leaves the key
// unchanged.
func (s *Store) UpdateAccount(ctx context.Context, id int64, patch domain.AccountPatch) (domain.AccountSummary, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	current, err := s.GetAccount(ctx, id)
	if err != nil {
		return domain.AccountSummary{}, err
	}

	name := current.Name
	if patch.Name != nil {
		trimmed := strings.TrimSpace(*patch.Name)
		if trimmed == "" || len(trimmed) > 128 {
			return domain.AccountSummary{}, invalidAccount("name must be a non-empty string of at most 128 characters")
		}
		name = trimmed
	}

	apiKey := current.APIKey
	if patch.APIKey != nil && strings.TrimSpace(*patch.APIKey) != "" {
		key := strings.TrimSpace(*patch.APIKey)
		if err := validateAPIKey(key); err != nil {
			return domain.AccountSummary{}, err
		}
		apiKey = key
	}

	enabled := current.Enabled
	if patch.Enabled != nil {
		enabled = *patch.Enabled
	}

	result, err := s.db.ExecContext(ctx,
		`UPDATE accounts SET name = ?, api_key = ?, enabled = ? WHERE id = ?`,
		name, apiKey, boolToInt(enabled), id,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return domain.AccountSummary{}, apierror.Coded(409, "account name already exists", "invalid_request_error", "account_name_taken")
		}
		return domain.AccountSummary{}, classifyDBError(err)
	}
	if affected, err := result.RowsAffected(); err != nil {
		return domain.AccountSummary{}, classifyDBError(err)
	} else if affected == 0 {
		return domain.AccountSummary{}, accountNotFound()
	}
	return s.accountSummary(ctx, id)
}

// DeleteAccount removes an account. Logs and gallery rows keep their account
// name snapshots.
func (s *Store) DeleteAccount(ctx context.Context, id int64) (bool, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	result, err := s.db.ExecContext(ctx, `DELETE FROM accounts WHERE id = ?`, id)
	if err != nil {
		return false, classifyDBError(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, classifyDBError(err)
	}
	return affected > 0, nil
}

// Claim atomically selects and reserves the next healthy account, excluding
// already-tried ids. It returns nil when no account is eligible.
func (s *Store) Claim(ctx context.Context, exclude []int64) (*domain.ClaimedAccount, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	now := formatTime(s.now())
	query := `UPDATE accounts
		SET use_seq = (SELECT COALESCE(MAX(use_seq), 0) + 1 FROM accounts),
		    last_used_at = ?,
		    status = CASE WHEN cooldown_until IS NOT NULL AND cooldown_until > ? THEN 'cooling' ELSE 'healthy' END
		WHERE id = (
			SELECT id FROM accounts
			WHERE enabled = 1
			  AND (cooldown_until IS NULL OR cooldown_until <= ?)`
	args := []any{now, now, now}
	if len(exclude) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(exclude)), ",")
		query += " AND id NOT IN (" + placeholders + ")"
		for _, id := range exclude {
			args = append(args, id)
		}
	}
	query += ` ORDER BY use_seq ASC, id ASC LIMIT 1)
		RETURNING id, name, api_key, fail_count`

	var claimed domain.ClaimedAccount
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&claimed.ID, &claimed.Name, &claimed.APIKey, &claimed.FailCount)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, classifyDBError(err)
	}
	return &claimed, nil
}

// RecordSuccess increments success counters. Health reset is a compare-and-
// swap on the claim-time failure count so a concurrent failure is never
// erased.
func (s *Store) RecordSuccess(ctx context.Context, id int64, expectedFailCount int64, images int) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	_, err := s.db.ExecContext(ctx,
		`UPDATE accounts SET
			upstream_requests = upstream_requests + 1,
			upstream_images = upstream_images + ?,
			fail_count = CASE WHEN fail_count = ? THEN 0 ELSE fail_count END,
			cooldown_until = CASE WHEN fail_count = ? THEN NULL ELSE cooldown_until END,
			status = CASE WHEN fail_count = ? THEN 'healthy' ELSE status END
		 WHERE id = ?`,
		images, expectedFailCount, expectedFailCount, expectedFailCount, id,
	)
	return classifyDBError(err)
}

// RecordFailure increments the failure count and extends the cooldown, never
// shortening an existing one.
func (s *Store) RecordFailure(ctx context.Context, id int64, cooldown time.Duration) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	if cooldown < 0 {
		cooldown = 0
	}
	until := formatTime(s.now().Add(cooldown))
	_, err := s.db.ExecContext(ctx,
		`UPDATE accounts SET
			fail_count = fail_count + 1,
			cooldown_until = CASE WHEN cooldown_until IS NULL OR cooldown_until < ? THEN ? ELSE cooldown_until END,
			status = 'cooling'
		 WHERE id = ?`,
		until, until, id,
	)
	return classifyDBError(err)
}

// ResetHealth clears cooldown and failure state.
func (s *Store) ResetHealth(ctx context.Context, id int64) (bool, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	result, err := s.db.ExecContext(ctx,
		`UPDATE accounts SET status = 'healthy', cooldown_until = NULL, fail_count = 0 WHERE id = ?`, id)
	if err != nil {
		return false, classifyDBError(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, classifyDBError(err)
	}
	return affected > 0, nil
}

const accountSummaryColumns = `SELECT id, name, api_key, enabled, cooldown_until, fail_count,
	last_used_at, upstream_requests, upstream_images, created_at FROM accounts`

func (s *Store) accountSummary(ctx context.Context, id int64) (domain.AccountSummary, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	row := s.db.QueryRowContext(ctx, accountSummaryColumns+` WHERE id = ?`, id)
	summary, err := scanAccountSummary(row, s.now().UTC())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.AccountSummary{}, accountNotFound()
		}
		return domain.AccountSummary{}, classifyDBError(err)
	}
	return summary, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAccountSummary(row rowScanner, now time.Time) (domain.AccountSummary, error) {
	var (
		summary   domain.AccountSummary
		apiKey    string
		enabled   int
		cooldown  sql.NullString
		lastUsed  sql.NullString
		createdAt string
	)
	if err := row.Scan(&summary.ID, &summary.Name, &apiKey, &enabled, &cooldown, &summary.FailCount,
		&lastUsed, &summary.UpstreamRequests, &summary.UpstreamImages, &createdAt); err != nil {
		return domain.AccountSummary{}, err
	}
	parsedCooldown, err := parseNullTime(cooldown)
	if err != nil {
		return domain.AccountSummary{}, err
	}
	parsedLastUsed, err := parseNullTime(lastUsed)
	if err != nil {
		return domain.AccountSummary{}, err
	}
	created, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return domain.AccountSummary{}, err
	}
	summary.APIKeyMasked = domain.MaskAPIKey(apiKey)
	summary.Enabled = enabled != 0
	summary.CooldownUntil = parsedCooldown
	summary.LastUsedAt = parsedLastUsed
	summary.Status = domain.AccountStatusFor(summary.Enabled, parsedCooldown, now)
	summary.CreatedAt = created.UTC()
	return summary, nil
}

func scanAccount(row rowScanner, now time.Time) (domain.Account, error) {
	var (
		account   domain.Account
		enabled   int
		cooldown  sql.NullString
		lastUsed  sql.NullString
		createdAt string
	)
	if err := row.Scan(&account.ID, &account.Name, &account.APIKey, &enabled, &account.Status, &cooldown,
		&account.FailCount, &lastUsed, &account.UpstreamRequests, &account.UpstreamImages, &createdAt); err != nil {
		return domain.Account{}, err
	}
	parsedCooldown, err := parseNullTime(cooldown)
	if err != nil {
		return domain.Account{}, err
	}
	parsedLastUsed, err := parseNullTime(lastUsed)
	if err != nil {
		return domain.Account{}, err
	}
	created, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return domain.Account{}, err
	}
	account.Enabled = enabled != 0
	account.CooldownUntil = parsedCooldown
	account.LastUsedAt = parsedLastUsed
	account.Status = domain.AccountStatusFor(account.Enabled, parsedCooldown, now)
	account.CreatedAt = created.UTC()
	return account, nil
}

func validateAccountFields(name, apiKey string, requireKey bool) (string, string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 128 {
		return "", "", invalidAccount("name must be a non-empty string of at most 128 characters")
	}
	apiKey = strings.TrimSpace(apiKey)
	if requireKey {
		if err := validateAPIKey(apiKey); err != nil {
			return "", "", err
		}
	}
	return name, apiKey, nil
}

func validateAPIKey(key string) error {
	if key == "" || len(key) > 4096 {
		return invalidAccount("apiKey must be a non-empty string of at most 4096 characters")
	}
	if strings.ContainsAny(key, " \t\r\n") {
		return invalidAccount("apiKey must not contain whitespace")
	}
	return nil
}

func invalidAccount(message string) error {
	return apierror.Coded(400, message, "invalid_request_error", "invalid_account")
}

func accountNotFound() error {
	return apierror.Coded(404, "account not found", "invalid_request_error", "account_not_found")
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToUpper(err.Error())
	return strings.Contains(message, "UNIQUE CONSTRAINT FAILED") || strings.Contains(message, "CONSTRAINT_FAILED")
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
