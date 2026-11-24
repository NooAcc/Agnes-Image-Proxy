package httpapi

import (
	"net/http"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

func (r *router) handleLogs(w http.ResponseWriter, req *http.Request) {
	switch req.Method {
	case http.MethodGet:
		query, err := parseCursorQuery(req)
		if err != nil {
			apierror.Write(w, err)
			return
		}
		page, err := r.options.Store.ListLogs(req.Context(), query)
		if err != nil {
			apierror.Write(w, err)
			return
		}
		writeAdminJSON(w, http.StatusOK, page)
	case http.MethodDelete:
		if err := r.options.Store.ClearLogs(req.Context()); err != nil {
			apierror.Write(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w, "GET, DELETE")
	}
}
