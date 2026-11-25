package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// StorageStore is the storage-configuration boundary for the management API.
type StorageStore interface {
	StorageStatus(ctx context.Context) (domain.StorageStatus, error)
	InitializeStorage(ctx context.Context, in domain.StorageInit) (domain.StorageStatus, error)
	UpdateImgbedStorage(ctx context.Context, in domain.StorageUpdate) (domain.StorageStatus, error)
}

// requireInitialized blocks every non-setup management or data operation until
// the administrator has fixed the storage mode.
func (r *router) requireInitialized(ctx context.Context) error {
	if r.options.Storage == nil {
		return apierror.Coded(http.StatusServiceUnavailable, "storage management is unavailable", "server_error", "service_unavailable")
	}
	status, err := r.options.Storage.StorageStatus(ctx)
	if err != nil {
		return err
	}
	if !status.Initialized {
		return apierror.Coded(http.StatusServiceUnavailable, "storage is not initialized", "server_error", "initialization_required")
	}
	return nil
}

// Local copies of the storage-state conflicts keep the HTTP precedence rule
// (persisted state before payload validation) independent of the store call.
func storageAlreadyInitialized() error {
	return apierror.Coded(http.StatusConflict, "storage is already initialized", "invalid_request_error", "already_initialized")
}

func storageNotInitialized() error {
	return apierror.Coded(http.StatusConflict, "storage is not initialized", "invalid_request_error", "not_initialized")
}

func storageModeFixed() error {
	return apierror.Coded(http.StatusConflict, "storage mode is fixed after initialization", "invalid_request_error", "storage_mode_fixed")
}

func (r *router) handleStorage(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.options.Storage == nil {
		apierror.Write(w, apierror.Coded(http.StatusServiceUnavailable, "storage management is unavailable", "server_error", "service_unavailable"))
		return
	}
	switch req.Method {
	case http.MethodGet:
		status, err := r.options.Storage.StorageStatus(req.Context())
		if err != nil {
			apierror.Write(w, err)
			return
		}
		writeAdminJSON(w, http.StatusOK, status)
	case http.MethodPost:
		r.handleStorageInit(w, req)
	case http.MethodPut:
		r.handleStorageUpdate(w, req)
	default:
		methodNotAllowed(w, "GET, POST, PUT")
	}
}

func (r *router) handleStorageInit(w http.ResponseWriter, req *http.Request) {
	fields, err := decodeStorageObject(w, req)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	status, err := r.options.Storage.StorageStatus(req.Context())
	if err != nil {
		apierror.Write(w, err)
		return
	}
	if status.Initialized {
		apierror.Write(w, storageAlreadyInitialized())
		return
	}
	if err := rejectUnknownStorageFields(fields, "mode", "imgbedBaseUrl", "imgbedToken"); err != nil {
		apierror.Write(w, err)
		return
	}
	rawMode, ok := fields["mode"]
	if !ok {
		apierror.Write(w, apierror.Invalid("mode", "mode is required", "invalid_value"))
		return
	}
	var in domain.StorageInit
	if err := json.Unmarshal(rawMode, &in.Mode); err != nil {
		apierror.Write(w, apierror.Invalid("mode", "mode must be local or imgbed", "invalid_value"))
		return
	}
	_, hasBase := fields["imgbedBaseUrl"]
	_, hasToken := fields["imgbedToken"]
	if in.Mode == domain.StorageLocal && (hasBase || hasToken) {
		// Presence, not value: local must not carry even null imgbed fields.
		apierror.Write(w, apierror.Invalid("imgbedBaseUrl", "local storage does not accept imgbed fields", "invalid_value"))
		return
	}
	if hasBase {
		value, err := storageString(fields["imgbedBaseUrl"], "imgbedBaseUrl")
		if err != nil {
			apierror.Write(w, err)
			return
		}
		in.ImgbedBaseURL = &value
	}
	if hasToken {
		value, err := storageString(fields["imgbedToken"], "imgbedToken")
		if err != nil {
			apierror.Write(w, err)
			return
		}
		in.ImgbedToken = &value
	}
	status, err = r.options.Storage.InitializeStorage(req.Context(), in)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	writeAdminJSON(w, http.StatusCreated, status)
}

func (r *router) handleStorageUpdate(w http.ResponseWriter, req *http.Request) {
	fields, err := decodeStorageObject(w, req)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	status, err := r.options.Storage.StorageStatus(req.Context())
	if err != nil {
		apierror.Write(w, err)
		return
	}
	if !status.Initialized {
		apierror.Write(w, storageNotInitialized())
		return
	}
	if status.Mode != domain.StorageImgbed {
		apierror.Write(w, storageModeFixed())
		return
	}
	if err := rejectUnknownStorageFields(fields, "imgbedBaseUrl", "imgbedToken"); err != nil {
		apierror.Write(w, err)
		return
	}
	rawBase, ok := fields["imgbedBaseUrl"]
	if !ok {
		apierror.Write(w, apierror.Invalid("imgbedBaseUrl", "imgbedBaseUrl is required", "invalid_value"))
		return
	}
	base, err := storageString(rawBase, "imgbedBaseUrl")
	if err != nil {
		apierror.Write(w, err)
		return
	}
	in := domain.StorageUpdate{ImgbedBaseURL: base}
	if rawToken, ok := fields["imgbedToken"]; ok {
		token, err := storageString(rawToken, "imgbedToken")
		if err != nil {
			apierror.Write(w, err)
			return
		}
		in.ImgbedToken = &token
	}
	status, err = r.options.Storage.UpdateImgbedStorage(req.Context(), in)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	writeAdminJSON(w, http.StatusOK, status)
}

// storageString rejects null and non-string values: an explicit null token must
// not be mistaken for "omit and retain".
func storageString(raw json.RawMessage, field string) (string, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", apierror.Invalid(field, field+" must be a string", "invalid_value")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", apierror.Invalid(field, field+" must be a string", "invalid_value")
	}
	return value, nil
}

func rejectUnknownStorageFields(fields map[string]json.RawMessage, allowed ...string) error {
	known := make(map[string]bool, len(allowed))
	for _, field := range allowed {
		known[field] = true
	}
	for field := range fields {
		if !known[field] {
			return apierror.Invalid(field, "unknown field", "invalid_value")
		}
	}
	return nil
}

func decodeStorageObject(w http.ResponseWriter, req *http.Request) (map[string]json.RawMessage, error) {
	req.Body = http.MaxBytesReader(w, req.Body, maxAdminJSONBytes)
	decoder := json.NewDecoder(req.Body)
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return nil, apierror.Invalid("body", "request body must be a JSON object with known fields", "invalid_value")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, apierror.Invalid("body", "request body must contain exactly one JSON object", "invalid_value")
	}
	return fields, nil
}
