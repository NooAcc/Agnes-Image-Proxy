package httpapi

import (
	"net/http"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

const dayLayout = "2006-01-02"

func (r *router) handleOverview(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		methodNotAllowed(w, "GET")
		return
	}
	values := req.URL.Query()
	end := values.Get("end")
	start := values.Get("start")
	if end == "" {
		end = time.Now().UTC().Format(dayLayout)
	}
	if start == "" {
		start = time.Now().UTC().AddDate(0, 0, -6).Format(dayLayout)
	}
	overview, err := r.options.Store.Overview(req.Context(), start, end)
	if err != nil {
		apierror.Write(w, err)
		return
	}
	writeAdminJSON(w, http.StatusOK, overview)
}
