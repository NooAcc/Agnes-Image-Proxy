package httpapi

import (
	"net/http"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

func (r *router) handleSettings(w http.ResponseWriter, req *http.Request) {
	switch req.Method {
	case http.MethodGet:
		settings, err := r.options.Store.ReadSettings(req.Context())
		if err != nil {
			apierror.Write(w, err)
			return
		}
		writeAdminJSON(w, http.StatusOK, settings)
	case http.MethodPut:
		var settings domain.Settings
		if err := decodeAdminBody(w, req, &settings); err != nil {
			apierror.Write(w, err)
			return
		}
		validated, err := domain.ValidateSettings(settings)
		if err != nil {
			apierror.Write(w, err)
			return
		}
		if err := r.options.Store.WriteSettings(req.Context(), validated); err != nil {
			apierror.Write(w, err)
			return
		}
		writeAdminJSON(w, http.StatusOK, validated)
	default:
		methodNotAllowed(w, "GET, PUT")
	}
}
