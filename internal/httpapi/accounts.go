package httpapi

import (
	"errors"
	"net/http"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const maxImportAccounts = 1000

func (r *router) handleAccounts(w http.ResponseWriter, req *http.Request, parts []string) {
	switch {
	case len(parts) == 0:
		switch req.Method {
		case http.MethodGet:
			r.listAccounts(w, req)
		case http.MethodPost:
			r.createAccount(w, req)
		default:
			methodNotAllowed(w, "GET, POST")
		}
	case len(parts) == 1 && parts[0] == "import":
		if req.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		r.importAccounts(w, req)
	case len(parts) == 1 && parts[0] == "test":
		if req.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		r.probeAll(w, req)
	case len(parts) == 1:
		id, err := parseAdminID(parts[0])
		if err != nil {
			apierror.Write(w, err)
			return
		}
		switch req.Method {
		case http.MethodPatch:
			r.updateAccount(w, req, id)
		case http.MethodDelete:
			r.deleteAccount(w, req, id)
		default:
			methodNotAllowed(w, "PATCH, DELETE")
		}
	case len(parts) == 2 && parts[1] == "test":
		if req.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		id, err := parseAdminID(parts[0])
		if err != nil {
			apierror.Write(w, err)
			return
		}
		r.probeOne(w, req, id)
	case len(parts) == 2 && parts[1] == "reset":
		if req.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		id, err := parseAdminID(parts[0])
		if err != nil {
			apierror.Write(w, err)
			return
		}
		found, err := r.options.Store.ResetHealth(req.Context(), id)
		if err != nil {
			apierror.Write(w, err)
			return
		}
		if !found {
			apierror.Write(w, apierror.Coded(http.StatusNotFound, "account not found", "invalid_request_error", "account_not_found"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		adminNotFound(w)
	}
}

func (r *router) listAccounts(w http.ResponseWriter, req *http.Request) {
	items, err := r.options.Store.ListAccounts(req.Context())
	if err != nil {
		apierror.Write(w, err)
		return
	}
	writeAdminJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (r *router) createAccount(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Name   string `json:"name"`
		APIKey string `json:"apiKey"`
	}
	if err := decodeAdminBody(w, req, &body); err != nil {
		apierror.Write(w, err)
		return
	}
	summary, err := r.options.Store.CreateAccount(req.Context(), body.Name, body.APIKey)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	writeAdminJSON(w, http.StatusCreated, summary)
}

func (r *router) updateAccount(w http.ResponseWriter, req *http.Request, id int64) {
	var patch domain.AccountPatch
	if err := decodeAdminBody(w, req, &patch); err != nil {
		apierror.Write(w, err)
		return
	}
	summary, err := r.options.Store.UpdateAccount(req.Context(), id, patch)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	writeAdminJSON(w, http.StatusOK, summary)
}

func (r *router) deleteAccount(w http.ResponseWriter, req *http.Request, id int64) {
	deleted, err := r.options.Store.DeleteAccount(req.Context(), id)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	if !deleted {
		apierror.Write(w, apierror.Coded(http.StatusNotFound, "account not found", "invalid_request_error", "account_not_found"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (r *router) importAccounts(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Accounts []struct {
			Name   string `json:"name"`
			APIKey string `json:"apiKey"`
		} `json:"accounts"`
	}
	if err := decodeAdminBody(w, req, &body); err != nil {
		apierror.Write(w, err)
		return
	}
	if len(body.Accounts) > maxImportAccounts {
		apierror.Write(w, apierror.Invalid("accounts", "at most 1000 accounts may be imported at once", "invalid_value"))
		return
	}
	type importError struct {
		Index   int    `json:"index"`
		Message string `json:"message"`
	}
	imported := 0
	failures := make([]importError, 0)
	for index, account := range body.Accounts {
		if _, err := r.options.Store.CreateAccount(req.Context(), account.Name, account.APIKey); err != nil {
			message := "invalid account"
			var apiErr *apierror.Error
			if errors.As(err, &apiErr) {
				message = apiErr.Message
			}
			failures = append(failures, importError{Index: index, Message: message})
			continue
		}
		imported++
	}
	writeAdminJSON(w, http.StatusOK, map[string]any{"imported": imported, "errors": failures})
}
