package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"modernc.org/sqlite"
)

// Intercept the SQL transport boundary while retaining real SQLite execution.
// afterQuery runs only after Next has executed the underlying statement.
type localFaults struct {
	before             func(string)
	afterQuery         func(string) error
	afterExec          func(string) error
	acceptDelayedExec  func(string, []driver.NamedValue) bool
	acceptDelayedQuery func(string, []driver.NamedValue) bool
}
type localConnector struct {
	dsn    string
	faults *localFaults
}

func (c localConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := (&sqlite.Driver{}).Open(c.dsn)
	if err != nil {
		return nil, err
	}
	return &localFaultConn{Conn: conn, faults: c.faults}, nil
}
func (c localConnector) Driver() driver.Driver { return &sqlite.Driver{} }

type localFaultConn struct {
	driver.Conn
	faults *localFaults
}

func (c *localFaultConn) QueryContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	if c.faults.acceptDelayedQuery != nil && c.faults.acceptDelayedQuery(q, args) {
		return nil, context.Canceled
	}
	if c.faults.before != nil {
		c.faults.before(q)
	}
	rows, err := c.Conn.(driver.QueryerContext).QueryContext(ctx, q, args)
	if err != nil {
		return nil, err
	}
	return &localFaultRows{Rows: rows, q: q, faults: c.faults}, nil
}
func (c *localFaultConn) ExecContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	if c.faults.acceptDelayedExec != nil && c.faults.acceptDelayedExec(q, args) {
		return nil, context.Canceled
	}
	if c.faults.before != nil {
		c.faults.before(q)
	}
	result, err := c.Conn.(driver.ExecerContext).ExecContext(ctx, q, args)
	if err == nil && c.faults.afterExec != nil {
		err = c.faults.afterExec(q)
	}
	return result, err
}

type localFaultRows struct {
	driver.Rows
	q      string
	faults *localFaults
	seen   bool
}

func (r *localFaultRows) Next(values []driver.Value) error {
	err := r.Rows.Next(values)
	if err == nil && !r.seen {
		r.seen = true
		if r.faults.afterQuery != nil {
			return r.faults.afterQuery(r.q)
		}
	}
	return err
}
func faultGallery(t *testing.T, faults *localFaults) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	db := sql.OpenDB(localConnector{dsn: "file:" + filepath.Join(dir, "test.db") + "?_pragma=busy_timeout(5000)", faults: faults})
	t.Cleanup(func() { _ = db.Close() })
	s, err := New(db, time.Now, filepath.Join(dir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s, filepath.Join(dir, "data")
}
func TestLocalGalleryDelayedInsertCannotReviveAfterClear(t *testing.T) {
	for _, reset := range []bool{false, true} {
		t.Run(fmt.Sprint(reset), func(t *testing.T) {
			var once atomic.Bool
			var query string
			var arguments []any
			faults := &localFaults{acceptDelayedQuery: func(q string, args []driver.NamedValue) bool {
				if strings.Contains(q, "INSERT INTO gallery") && once.CompareAndSwap(false, true) {
					query = q
					for _, arg := range args {
						arguments = append(arguments, arg.Value)
					}
					return true
				}
				return false
			}}
			s, _ := faultGallery(t, faults)
			ctx := context.Background()
			if _, err := s.SaveGeneratedImage(ctx, localInsert("delayed")); !errors.Is(err, context.Canceled) {
				t.Fatal("expected canceled response", err)
			}
			var err error
			if reset {
				err = s.ResetSchema(ctx, true)
			} else {
				err = s.ClearGallery(ctx)
			}
			if err != nil {
				t.Fatal(err)
			}
			// Execute the accepted server statement only after cleanup has returned.
			rows, err := s.db.QueryContext(ctx, query, arguments...)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			_ = rows.Close()
			var count int
			if err := s.db.QueryRow("SELECT count(*) FROM gallery").Scan(&count); err != nil || count != 0 {
				t.Fatal("delayed INSERT revived cleared gallery", count, err)
			}
			if _, err := s.SaveGeneratedImage(ctx, localInsert("new")); err != nil {
				t.Fatal("new generation cannot save", err)
			}
		})
	}
}

func TestLocalGalleryDelayedImageOperationCannotTouchResetID(t *testing.T) {
	for _, operation := range []string{"delete", "enrich"} {
		t.Run(operation, func(t *testing.T) {
			faults := &localFaults{}
			s, _ := faultGallery(t, faults)
			ctx := context.Background()
			old, err := s.SaveGeneratedImage(ctx, localInsert("old"))
			if err != nil {
				t.Fatal(err)
			}
			var query string
			var arguments []any
			var once atomic.Bool
			faults.acceptDelayedExec = func(q string, args []driver.NamedValue) bool {
				match := operation == "delete" && strings.Contains(q, "DELETE FROM gallery WHERE") || operation == "enrich" && strings.Contains(q, "UPDATE gallery SET enrich_status")
				if match && once.CompareAndSwap(false, true) {
					query = q
					for _, arg := range args {
						arguments = append(arguments, arg.Value)
					}
					return true
				}
				return false
			}
			if operation == "delete" {
				_, err = s.DeleteGallery(ctx, old.ID)
			} else {
				err = s.SetEnrichment(ctx, old.ID, domain.EnrichmentWrite{Status: "failed"})
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatal("expected canceled operation", err)
			}
			if err := s.ResetSchema(ctx, true); err != nil {
				t.Fatal(err)
			}
			next, err := s.SaveGeneratedImage(ctx, localInsert("new"))
			if err != nil {
				t.Fatal(err)
			}
			if next.ID != old.ID {
				t.Fatal("test did not reuse numeric ID")
			}
			if _, err := s.db.ExecContext(ctx, query, arguments...); err != nil {
				t.Fatal(err)
			}
			var status string
			if err := s.db.QueryRow("SELECT enrich_status FROM gallery WHERE id=?", next.ID).Scan(&status); err != nil || status != "pending" {
				t.Fatal("old delayed operation mutated new identity", status, err)
			}
			if _, _, err := s.PublicImageContent(ctx, next.PublicID); err != nil {
				t.Fatal("new image invalidated", err)
			}
		})
	}
}

func TestLocalGalleryCommittedSQLErrorKeepsOriginal(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	faults := &localFaults{afterQuery: func(q string) error {
		if strings.Contains(q, "INSERT INTO gallery") && fail.Swap(false) {
			return errors.New("response lost after commit")
		}
		return nil
	}}
	s, _ := faultGallery(t, faults)
	ctx := context.Background()
	in := localInsert("ambiguous-sql")
	if _, err := s.SaveGeneratedImage(ctx, in); err == nil {
		t.Fatal("transport error hidden")
	}
	var id int64
	if err := s.db.QueryRow("SELECT id FROM gallery WHERE output_key=?", in.OutputKey).Scan(&id); err != nil {
		t.Fatal("statement did not commit", err)
	}
	if _, err := s.files.stat(ctx, originalPath(t, s, id)); err != nil {
		t.Fatal("committed file removed", err)
	}
	in.Image = []byte("changed retry")
	saved, data, err := s.SaveDeliveryImage(ctx, in, true)
	if err != nil || saved.ID != id || string(data) != "first original" {
		t.Fatal("ambiguous retry changed authority", err)
	}
}
func TestLocalGalleryClearWaitsForSave(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once atomic.Bool
	faults := &localFaults{before: func(q string) {
		if strings.Contains(q, "INSERT INTO gallery") && once.CompareAndSwap(false, true) {
			close(entered)
			<-release
		}
	}}
	s, _ := faultGallery(t, faults)
	ctx := context.Background()
	saveDone := make(chan error, 1)
	clearDone := make(chan error, 1)
	go func() { _, err := s.SaveGeneratedImage(ctx, localInsert("before-clear")); saveDone <- err }()
	<-entered
	go func() { clearDone <- s.ClearGallery(ctx) }()
	select {
	case err := <-clearDone:
		t.Fatal("clear bypassed save", err)
	default:
	}
	close(release)
	if err := <-saveDone; err != nil {
		t.Fatal(err)
	}
	if err := <-clearDone; err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM gallery").Scan(&count); err != nil || count != 0 {
		t.Fatal("clear ordering", count, err)
	}
	saved, err := s.SaveGeneratedImage(ctx, localInsert("after-clear"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.PublicImageContent(ctx, saved.PublicID); err != nil {
		t.Fatal("new content removed by clear", err)
	}
}
