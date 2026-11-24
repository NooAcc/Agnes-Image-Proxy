package store

import (
	"context"
	"database/sql"
	"net/url"
	"strings"
	"time"

	"github.com/tursodatabase/libsql-client-go/libsql"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

// DefaultTimeout bounds every database operation.
const DefaultTimeout = 15 * time.Second

// Options configures a remote Turso connection.
type Options struct {
	URL       string
	AuthToken string
	Timeout   time.Duration
}

// Store is the single database/sql-backed storage implementation.
type Store struct {
	db      *sql.DB
	now     func() time.Time
	timeout time.Duration
}

// New wraps an existing database handle. Tests and preview use this with a
// local SQLite database; production uses Open.
func New(db *sql.DB, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, now: now, timeout: DefaultTimeout}
}

// operation bounds the whole storage operation, including row consumption and
// transactions. Nested operations retain the earlier parent's deadline.
func (s *Store) operation(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := s.timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return context.WithTimeout(ctx, timeout)
}

// Open connects to Turso over the libSQL HTTP protocol.
func Open(ctx context.Context, opts Options) (*Store, error) {
	if err := validateURL(opts.URL); err != nil {
		return nil, err
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	var options []libsql.Option
	if opts.AuthToken != "" {
		options = append(options, libsql.WithAuthToken(opts.AuthToken))
	}
	connector, err := libsql.NewConnector(opts.URL, options...)
	if err != nil {
		return nil, unavailable()
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)
	db.SetConnMaxIdleTime(5 * time.Minute)

	pingCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// The deprecation-era driver's Ping methods predate Go 1.26's context-aware
	// driver.Pinger, so run a real statement to prove connectivity.
	var one int
	if err := db.QueryRowContext(pingCtx, "SELECT 1").Scan(&one); err != nil {
		_ = db.Close()
		return nil, unavailable()
	}
	s := New(db, time.Now)
	s.timeout = timeout
	return s, nil
}

// Ping proves the database still answers a trivial statement. It is used by
// the deep health check.
func (s *Store) Ping(ctx context.Context) error {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	var one int
	if err := s.db.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil {
		return classifyDBError(err)
	}
	return nil
}

// Close releases the underlying database handle.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func unavailable() *apierror.Error {
	return apierror.Coded(503, "database unavailable", "server_error", "database_unavailable")
}

func validateURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return apierror.Coded(500, "invalid database URL", "server_error", "invalid_database_url")
	}
	if u.Scheme != "libsql" && u.Scheme != "https" {
		return apierror.Coded(500, "invalid database URL", "server_error", "invalid_database_url")
	}
	if u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.TrimSpace(u.Host) == "" {
		return apierror.Coded(500, "invalid database URL", "server_error", "invalid_database_url")
	}
	return nil
}
