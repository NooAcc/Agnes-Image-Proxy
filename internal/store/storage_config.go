package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const storageConfigColumns = `SELECT mode, imgbed_base_url, imgbed_token, created_at, updated_at FROM storage_config WHERE id = 1`

func alreadyInitialized() error {
	return apierror.Coded(409, "storage is already initialized", "invalid_request_error", "already_initialized")
}

func storageNotInitialized() error {
	return apierror.Coded(409, "storage is not initialized", "invalid_request_error", "not_initialized")
}

func storageModeFixed() error {
	return apierror.Coded(409, "storage mode is fixed after initialization", "invalid_request_error", "storage_mode_fixed")
}

func invalidStorageConfig() error {
	return apierror.Coded(503, "stored storage configuration is invalid", "server_error", "invalid_storage_config")
}

// ReadStorageConfig returns the full configuration, including the ImgBed
// token, under a shared snapshot. found=false means the database has not been
// initialized; an unreadable or invalid row is an error, never "uninitialized".
func (s *Store) ReadStorageConfig(ctx context.Context) (domain.StorageConfig, bool, error) {
	release, err := s.storageGate.acquire(ctx, false)
	if err != nil {
		return domain.StorageConfig{}, false, err
	}
	defer release()
	ctx, cancel := s.operation(ctx)
	defer cancel()
	return s.readStorageConfig(ctx)
}

// readStorageConfig is the database-only helper for callers that already hold
// the storage gate. It needs a context that is already bounded by operation.
func (s *Store) readStorageConfig(ctx context.Context) (domain.StorageConfig, bool, error) {
	var (
		mode      string
		baseURL   sql.NullString
		token     sql.NullString
		createdAt string
		updatedAt string
	)
	err := s.db.QueryRowContext(ctx, storageConfigColumns).Scan(&mode, &baseURL, &token, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.StorageConfig{}, false, nil
	}
	if err != nil {
		return domain.StorageConfig{}, false, classifyDBError(err)
	}
	config, err := validateStoredStorageConfig(mode, baseURL, token)
	if err != nil {
		return domain.StorageConfig{}, false, err
	}
	return config, true, nil
}

func validateStoredStorageConfig(mode string, baseURL, token sql.NullString) (domain.StorageConfig, error) {
	config := domain.StorageConfig{Mode: domain.StorageMode(mode)}
	switch config.Mode {
	case domain.StorageLocal:
		if baseURL.Valid || token.Valid {
			return domain.StorageConfig{}, invalidStorageConfig()
		}
	case domain.StorageImgbed:
		if !baseURL.Valid || !token.Valid || baseURL.String == "" || token.String == "" {
			return domain.StorageConfig{}, invalidStorageConfig()
		}
		normalized, err := domain.NormalizeImgbedBaseURL(baseURL.String)
		if err != nil || normalized != baseURL.String {
			return domain.StorageConfig{}, invalidStorageConfig()
		}
		checked, err := domain.ValidateImgbedToken(token.String)
		if err != nil || checked != token.String {
			return domain.StorageConfig{}, invalidStorageConfig()
		}
		config.ImgbedBaseURL = normalized
		config.ImgbedToken = checked
	default:
		return domain.StorageConfig{}, invalidStorageConfig()
	}
	return config, nil
}

// StorageStatus returns the redacted management view.
func (s *Store) StorageStatus(ctx context.Context) (domain.StorageStatus, error) {
	config, found, err := s.ReadStorageConfig(ctx)
	if err != nil {
		return domain.StorageStatus{}, err
	}
	if !found {
		return domain.StorageStatus{}, nil
	}
	return config.Status(), nil
}

// InitializeStorage performs the single atomic first-run insert. A second,
// concurrent or later call never changes the fixed configuration.
func (s *Store) InitializeStorage(ctx context.Context, in domain.StorageInit) (domain.StorageStatus, error) {
	release, err := s.storageGate.acquire(ctx, true)
	if err != nil {
		return domain.StorageStatus{}, err
	}
	defer release()

	// An initialized installation answers 409 before validating or probing the
	// new payload: the fixed mode is the authoritative outcome of every retry.
	checkCtx, checkCancel := s.operation(ctx)
	_, found, err := s.readStorageConfig(checkCtx)
	checkCancel()
	if err != nil {
		return domain.StorageStatus{}, err
	}
	if found {
		return domain.StorageStatus{}, alreadyInitialized()
	}

	config, err := domain.ValidateStorageInit(in)
	if err != nil {
		return domain.StorageStatus{}, err
	}

	if config.Mode == domain.StorageLocal {
		if err := s.files.probe(ctx); err != nil {
			return domain.StorageStatus{}, localStorageError(err)
		}
	}

	ctx, cancel := s.operation(ctx)
	defer cancel()

	var baseURL, token any
	if config.Mode == domain.StorageImgbed {
		baseURL, token = config.ImgbedBaseURL, config.ImgbedToken
	}
	now := formatTime(s.now())
	result, err := s.db.ExecContext(ctx,
		`INSERT INTO storage_config (id, mode, imgbed_base_url, imgbed_token, created_at, updated_at)
		 VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
		string(config.Mode), baseURL, token, now, now,
	)
	if err != nil {
		return domain.StorageStatus{}, classifyDBError(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return domain.StorageStatus{}, classifyDBError(err)
	}
	if affected == 0 {
		return domain.StorageStatus{}, alreadyInitialized()
	}
	return config.Status(), nil
}

// UpdateImgbedStorage atomically updates the site address and, optionally, the
// token. It never changes the fixed mode.
func (s *Store) UpdateImgbedStorage(ctx context.Context, in domain.StorageUpdate) (domain.StorageStatus, error) {
	release, err := s.storageGate.acquire(ctx, true)
	if err != nil {
		return domain.StorageStatus{}, err
	}
	defer release()

	ctx, cancel := s.operation(ctx)
	defer cancel()
	config, found, err := s.readStorageConfig(ctx)
	if err != nil {
		return domain.StorageStatus{}, err
	}
	if !found {
		return domain.StorageStatus{}, storageNotInitialized()
	}
	if config.Mode != domain.StorageImgbed {
		return domain.StorageStatus{}, storageModeFixed()
	}
	update, keepToken, err := domain.ValidateStorageUpdate(in)
	if err != nil {
		return domain.StorageStatus{}, err
	}
	token := config.ImgbedToken
	if !keepToken {
		token = update.ImgbedToken
	}
	result, err := s.db.ExecContext(ctx,
		`UPDATE storage_config SET imgbed_base_url = ?, imgbed_token = ?, updated_at = ? WHERE id = 1`,
		update.ImgbedBaseURL, token, formatTime(s.now()),
	)
	if err != nil {
		return domain.StorageStatus{}, classifyDBError(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return domain.StorageStatus{}, classifyDBError(err)
	}
	if affected == 0 {
		return domain.StorageStatus{}, storageNotInitialized()
	}
	return domain.StorageConfig{Mode: domain.StorageImgbed, ImgbedBaseURL: update.ImgbedBaseURL, ImgbedToken: token}.Status(), nil
}
