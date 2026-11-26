package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

var fixedNow = func() time.Time {
	return time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
}

func newSchemaStore(t *testing.T) (*store.Store, *sql.DB) {
	t.Helper()
	db := testutil.OpenDB(t)
	s, constructErr := store.New(db, store.NewOptions{Now: fixedNow, DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	return s, db
}

// newInitializedSchemaStore is the fixture for tests that publish or read
// originals. The empty-schema assertions above deliberately keep using the
// uninitialized newSchemaStore.
func newInitializedSchemaStore(t *testing.T) (*store.Store, *sql.DB) {
	t.Helper()
	s, db := newSchemaStore(t)
	if _, err := s.InitializeStorage(context.Background(), domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		t.Fatalf("initialize local storage: %v", err)
	}
	return s, db
}

func TestEnsureSchemaCreatesAndReopens(t *testing.T) {
	_, db := newSchemaStore(t)

	var app, version string
	if err := db.QueryRow("SELECT value FROM app_meta WHERE key='application'").Scan(&app); err != nil {
		t.Fatalf("read application: %v", err)
	}
	if err := db.QueryRow("SELECT value FROM app_meta WHERE key='schema'").Scan(&version); err != nil {
		t.Fatalf("read schema: %v", err)
	}
	if app != "agnes-go" || version != "5" {
		t.Fatalf("unexpected meta: %q %q", app, version)
	}

	for _, table := range []string{"accounts", "generation_keys", "settings", "auth_state", "request_logs", "model_usage_daily", "gallery"} {
		var name string
		if err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name); err != nil {
			t.Fatalf("missing table %s: %v", table, err)
		}
	}

	var epoch int64
	if err := db.QueryRow("SELECT session_epoch FROM auth_state WHERE id=1").Scan(&epoch); err != nil {
		t.Fatalf("read epoch: %v", err)
	}
	if epoch != 1 {
		t.Fatalf("epoch = %d", epoch)
	}

	s, constructErr := store.New(db, store.NewOptions{Now: fixedNow, DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
}

func TestEnsureSchemaRejectsNonEmptyWithoutMutation(t *testing.T) {
	db := testutil.OpenDB(t)
	if _, err := db.Exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, api_key TEXT)`); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO accounts (id, api_key) VALUES (7, 'legacy')`); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}

	s, constructErr := store.New(db, store.NewOptions{Now: fixedNow, DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	err := s.EnsureSchema(context.Background())
	if err == nil {
		t.Fatal("expected non-empty database to be rejected")
	}
	var apiErr *apierror.Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected apierror, got %T", err)
	}

	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&count); err != nil {
		t.Fatalf("legacy table changed: %v", err)
	}
	if count != 1 {
		t.Fatalf("legacy rows changed: %d", count)
	}
	var appMeta int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='app_meta'").Scan(&appMeta)
	if err != nil {
		t.Fatalf("query meta: %v", err)
	}
	if appMeta != 0 {
		t.Fatal("app_meta must not be created before rejecting the database")
	}
}

func TestEnsureSchemaRejectsVersionMismatch(t *testing.T) {
	_, db := newSchemaStore(t)
	if _, err := db.Exec("UPDATE app_meta SET value='1' WHERE key='schema'"); err != nil {
		t.Fatalf("bump version: %v", err)
	}
	s, constructErr := store.New(db, store.NewOptions{Now: fixedNow, DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err == nil {
		t.Fatal("expected schema version mismatch")
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&count); err != nil {
		t.Fatalf("accounts table damaged: %v", err)
	}
}

func TestEnsureSchemaRejectsIncompleteSchema(t *testing.T) {
	db := testutil.OpenDB(t)
	if _, err := db.Exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		t.Fatalf("create meta: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_meta (key, value) VALUES ('application','agnes-go'),('schema','1')`); err != nil {
		t.Fatalf("insert meta: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatalf("create partial accounts: %v", err)
	}
	s, constructErr := store.New(db, store.NewOptions{Now: fixedNow, DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err == nil {
		t.Fatal("expected incomplete schema to be rejected")
	}
}

func TestSchemaBlobRoundTripAndRollback(t *testing.T) {
	_, db := newSchemaStore(t)

	blob := []byte{0x00, 0xff, 0x10, 0x00, 0x7f}

	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(`INSERT INTO gallery (public_id, output_key, created_at, thumb, enrich_status) VALUES ('0123456789abcdef0123456789abcdef', 'blob:0:0', ?, ?, 'pending')`,
		"2026-11-24T12:00:00Z", blob); err != nil {
		t.Fatalf("insert gallery: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM gallery").Scan(&count); err != nil {
		t.Fatalf("count after rollback: %v", err)
	}
	if count != 0 {
		t.Fatalf("rollback left %d rows", count)
	}

	if _, err := db.Exec(`INSERT INTO gallery (public_id, output_key, created_at, thumb, enrich_status) VALUES ('0123456789abcdef0123456789abcdef', 'blob:0:0', ?, ?, 'pending')`,
		"2026-11-24T12:00:00Z", blob); err != nil {
		t.Fatalf("insert gallery: %v", err)
	}
	var gotThumb []byte
	if err := db.QueryRow("SELECT thumb FROM gallery LIMIT 1").Scan(&gotThumb); err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if !bytes.Equal(gotThumb, blob) {
		t.Fatalf("backup mismatch: %x", gotThumb)
	}
}

func TestResetSchemaRequiresConfirmation(t *testing.T) {
	s, db := newSchemaStore(t)
	if _, err := db.Exec(`INSERT INTO accounts (name, api_key, created_at) VALUES ('a','k','2026-11-24T00:00:00Z')`); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	if err := s.ResetSchema(context.Background(), false); err == nil {
		t.Fatal("reset without confirmation must fail")
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&count); err != nil || count != 1 {
		t.Fatalf("reset without confirmation changed data: count=%d err=%v", count, err)
	}

	ctx := context.Background()
	if _, err := s.CreateGenerationKey(ctx, "client"); err != nil {
		t.Fatalf("create generation key: %v", err)
	}
	if err := s.ResetSchema(ctx, true); err != nil {
		t.Fatalf("confirmed reset: %v", err)
	}
	if items, err := s.ListGenerationKeys(ctx); err != nil || len(items) != 0 {
		t.Fatalf("reset did not clear generation keys: count=%d err=%v", len(items), err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&count); err != nil || count != 0 {
		t.Fatalf("reset did not clear accounts: count=%d err=%v", count, err)
	}
	var epoch int64
	if err := db.QueryRow("SELECT session_epoch FROM auth_state WHERE id=1").Scan(&epoch); err != nil || epoch != 1 {
		t.Fatalf("reset did not recreate auth state: epoch=%d err=%v", epoch, err)
	}
}

func TestEnsureSchemaHonorsCancellation(t *testing.T) {
	db := testutil.OpenDB(t)
	s, constructErr := store.New(db, store.NewOptions{Now: fixedNow, DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.EnsureSchema(ctx); err == nil {
		t.Fatal("expected canceled context to fail")
	}
}

func TestDefaultTimeout(t *testing.T) {
	if store.DefaultTimeout != 15*time.Second {
		t.Fatalf("default timeout = %v", store.DefaultTimeout)
	}
}
