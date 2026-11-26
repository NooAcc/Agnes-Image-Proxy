package store_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func newStoreForTest(t *testing.T, db *sql.DB) (*store.Store, error) {
	t.Helper()
	return store.New(db, store.NewOptions{Now: fixedNow, DataDir: t.TempDir()})
}

func apiCode(t *testing.T, err error) (int, string) {
	t.Helper()
	var ae *apierror.Error
	if !errors.As(err, &ae) {
		t.Fatalf("expected API error, got %T: %v", err, err)
	}
	code := ""
	if ae.Code != nil {
		code = *ae.Code
	}
	return ae.Status, code
}

func TestStorageSchemaUninitialized(t *testing.T) {
	s, db := newSchemaStore(t)
	ctx := context.Background()

	var version string
	if err := db.QueryRow("SELECT value FROM app_meta WHERE key='schema'").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != "6" {
		t.Fatalf("schema version = %q, want 6", version)
	}

	var count int
	if err := db.QueryRow("SELECT count(*) FROM storage_config").Scan(&count); err != nil {
		t.Fatalf("storage_config missing: %v", err)
	}
	if count != 0 {
		t.Fatalf("fresh database seeded %d storage rows", count)
	}

	var originalRef, imagePath int
	_ = db.QueryRow("SELECT count(*) FROM pragma_table_info('gallery') WHERE name='original_ref'").Scan(&originalRef)
	_ = db.QueryRow("SELECT count(*) FROM pragma_table_info('gallery') WHERE name='image_path'").Scan(&imagePath)
	if originalRef != 1 || imagePath != 0 {
		t.Fatalf("gallery columns original_ref=%d image_path=%d", originalRef, imagePath)
	}

	status, err := s.StorageStatus(ctx)
	if err != nil || status.Initialized {
		t.Fatalf("fresh status = %+v, %v", status, err)
	}
	raw, err := json.Marshal(status)
	if err != nil || string(raw) != `{"initialized":false}` {
		t.Fatalf("fresh status JSON = %s, %v", raw, err)
	}
}

func TestStorageInitAndRestartPersistence(t *testing.T) {
	s, _ := newSchemaStore(t)
	ctx := context.Background()

	status, err := s.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageLocal})
	if err != nil || status.Mode != domain.StorageLocal || !status.Initialized {
		t.Fatalf("init = %+v, %v", status, err)
	}
	raw, _ := json.Marshal(status)
	if string(raw) != `{"initialized":true,"mode":"local"}` {
		t.Fatalf("status = %s", raw)
	}
	config, found, err := s.ReadStorageConfig(ctx)
	if err != nil || !found || config.Mode != domain.StorageLocal {
		t.Fatalf("config = %+v found=%v err=%v", config, found, err)
	}

	// A second initialization never rewrites the fixed configuration.
	url, token := "https://img.example.com", "new-token"
	_, err = s.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageImgbed, ImgbedBaseURL: &url, ImgbedToken: &token})
	httpStatus, code := apiCode(t, err)
	if httpStatus != 409 || code != "already_initialized" {
		t.Fatalf("second init = %d %q", httpStatus, code)
	}
	config, _, _ = s.ReadStorageConfig(ctx)
	if config.Mode != domain.StorageLocal {
		t.Fatalf("mode changed to %q", config.Mode)
	}
}

func TestStorageInitConcurrent(t *testing.T) {
	s, _ := newSchemaStore(t)
	const n = 8
	errs := make(chan error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			in := domain.StorageInit{Mode: domain.StorageLocal}
			if i%2 == 1 {
				url, token := "https://img.example.com", "token"
				in = domain.StorageInit{Mode: domain.StorageImgbed, ImgbedBaseURL: &url, ImgbedToken: &token}
			}
			_, err := s.InitializeStorage(context.Background(), in)
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)

	succeeded, conflicts := 0, 0
	for err := range errs {
		if err == nil {
			succeeded++
			continue
		}
		if status, code := apiCode(t, err); status == 409 && code == "already_initialized" {
			conflicts++
			continue
		}
		t.Fatalf("unexpected concurrent init result: %v", err)
	}
	if succeeded != 1 || conflicts != n-1 {
		t.Fatalf("succeeded=%d conflicts=%d", succeeded, conflicts)
	}
	status, err := s.StorageStatus(context.Background())
	if err != nil || !status.Initialized {
		t.Fatalf("status after race = %+v, %v", status, err)
	}
}

func TestStorageUpdateFixedModeAndRetainedToken(t *testing.T) {
	s, db := newSchemaStore(t)
	ctx := context.Background()
	url, token := "https://img.example.com", "token-1"
	if _, err := s.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageImgbed, ImgbedBaseURL: &url, ImgbedToken: &token}); err != nil {
		t.Fatal(err)
	}

	empty := ""
	status, err := s.UpdateImgbedStorage(ctx, domain.StorageUpdate{ImgbedBaseURL: "https://New.Example.com/", ImgbedToken: &empty})
	if err != nil || status.ImgbedBaseURL != "https://new.example.com" || !status.HasImgbedToken {
		t.Fatalf("update retaining token = %+v, %v", status, err)
	}
	config, _, _ := s.ReadStorageConfig(ctx)
	if config.ImgbedToken != "token-1" {
		t.Fatalf("empty token replaced existing: %q", config.ImgbedToken)
	}

	replacement := "token-2"
	if _, err := s.UpdateImgbedStorage(ctx, domain.StorageUpdate{ImgbedBaseURL: "https://img.example.com", ImgbedToken: &replacement}); err != nil {
		t.Fatal(err)
	}
	config, _, _ = s.ReadStorageConfig(ctx)
	if config.ImgbedToken != "token-2" {
		t.Fatalf("token not replaced: %q", config.ImgbedToken)
	}

	// Raw SQL cannot change the fixed mode.
	if _, err := db.Exec(`UPDATE storage_config SET mode='local' WHERE id=1`); err == nil {
		t.Fatal("raw mode update was accepted")
	}

	// A local installation rejects connection updates.
	local, _ := newSchemaStore(t)
	if _, err := local.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		t.Fatal(err)
	}
	_, err = local.UpdateImgbedStorage(ctx, domain.StorageUpdate{ImgbedBaseURL: "https://img.example.com"})
	if status, code := apiCode(t, err); status != 409 || code != "storage_mode_fixed" {
		t.Fatalf("local update = %d %q", status, code)
	}

	// An uninitialized installation rejects updates.
	uninit, _ := newSchemaStore(t)
	_, err = uninit.UpdateImgbedStorage(ctx, domain.StorageUpdate{ImgbedBaseURL: "https://img.example.com"})
	if status, code := apiCode(t, err); status != 409 || code != "not_initialized" {
		t.Fatalf("uninitialized update = %d %q", status, code)
	}
}

func TestStorageStatePrecedesPayloadValidation(t *testing.T) {
	ctx := context.Background()
	s, db := newSchemaStore(t)
	url, token := "https://img.example.com", "token"
	if _, err := s.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageImgbed, ImgbedBaseURL: &url, ImgbedToken: &token}); err != nil {
		t.Fatal(err)
	}

	for name, in := range map[string]domain.StorageInit{
		"unknown mode":       {Mode: domain.StorageMode("s3")},
		"missing token":      {Mode: domain.StorageImgbed},
		"local after imgbed": {Mode: domain.StorageLocal},
	} {
		_, err := s.InitializeStorage(ctx, in)
		if status, code := apiCode(t, err); status != 409 || code != "already_initialized" {
			t.Fatalf("%s init = %d %q", name, status, code)
		}
	}

	// An initialized installation answers 409 before probing an unusable DATA_DIR.
	probeDir := t.TempDir()
	bad, err := store.New(db, store.NewOptions{DataDir: probeDir})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(probeDir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(probeDir, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := bad.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageLocal}); err == nil {
		t.Fatal("local init accepted")
	} else if status, code := apiCode(t, err); status != 409 || code != "already_initialized" {
		t.Fatalf("probe-before-state init = %d %q", status, code)
	}

	uninit, _ := newSchemaStore(t)
	_, err = uninit.UpdateImgbedStorage(ctx, domain.StorageUpdate{ImgbedBaseURL: "not a url"})
	if status, code := apiCode(t, err); status != 409 || code != "not_initialized" {
		t.Fatalf("uninitialized invalid update = %d %q", status, code)
	}

	local, _ := newSchemaStore(t)
	if _, err := local.InitializeStorage(ctx, domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		t.Fatal(err)
	}
	_, err = local.UpdateImgbedStorage(ctx, domain.StorageUpdate{ImgbedBaseURL: "not a url"})
	if status, code := apiCode(t, err); status != 409 || code != "storage_mode_fixed" {
		t.Fatalf("local invalid update = %d %q", status, code)
	}
}

func TestStorageCorruptRowNotUninitialized(t *testing.T) {
	db := testutil.OpenDB(t)
	if _, err := db.Exec(`CREATE TABLE storage_config (
		id INTEGER PRIMARY KEY, mode TEXT NOT NULL, imgbed_base_url TEXT, imgbed_token TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		INSERT INTO storage_config VALUES (1, 'local', 'https://img.example.com', 'token', 'now', 'now')`); err != nil {
		t.Fatal(err)
	}
	s, err := newStoreForTest(t, db)
	if err != nil {
		t.Fatal(err)
	}
	status, err := s.StorageStatus(context.Background())
	if err == nil {
		t.Fatalf("corrupt row reported status %+v", status)
	}
	if status.Initialized {
		t.Fatalf("corrupt row reported initialized")
	}
	if got, code := apiCode(t, err); got != 503 || code != "invalid_storage_config" {
		t.Fatalf("corrupt row error = %d %q", got, code)
	}
}
