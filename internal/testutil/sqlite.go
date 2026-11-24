package testutil

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// OpenDB opens an isolated on-disk SQLite database for a test and closes it
// when the test finishes. The file-backed database supports concurrent
// connections and busy waiting, matching the SQL surface used against Turso.
func OpenDB(t *testing.T) *sql.DB {
	t.Helper()
	path := t.TempDir() + "/test.db"
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
