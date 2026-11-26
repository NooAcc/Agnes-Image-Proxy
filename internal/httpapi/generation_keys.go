package httpapi

import (
	"net/http"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

type generationKeySummary struct {
	domain.GenerationKey
	KeyHint string `json:"keyHint"`
}

func summarizeGenerationKey(key domain.GenerationKey) generationKeySummary {
	return generationKeySummary{GenerationKey: key, KeyHint: auth.GenerationKeyPrefix + key.PublicID[:min(len(key.PublicID), 6)] + "…"}
}

func (r *router) handleGenerationKeys(w http.ResponseWriter, req *http.Request, parts []string) {
	ctx := req.Context()
	if len(parts) == 0 {
		switch req.Method {
		case http.MethodGet:
			keys, err := r.options.Store.ListGenerationKeys(ctx)
			if err != nil {
				apierror.Write(w, err)
				return
			}
			items := make([]generationKeySummary, 0, len(keys))
			for _, key := range keys {
				items = append(items, summarizeGenerationKey(key))
			}
			writeAdminJSON(w, http.StatusOK, map[string]any{"items": items})
		case http.MethodPost:
			var body struct {
				Name string `json:"name"`
			}
			if err := decodeAdminBody(w, req, &body); err != nil {
				apierror.Write(w, err)
				return
			}
			key, err := r.options.Store.CreateGenerationKey(ctx, body.Name)
			if err != nil {
				apierror.Write(w, err)
				return
			}
			writeAdminJSON(w, http.StatusCreated, summarizeGenerationKey(key))
		default:
			methodNotAllowed(w, "GET, POST")
		}
		return
	}
	if len(parts) != 1 || parts[0] == "" {
		adminNotFound(w)
		return
	}
	id, err := parseAdminID(parts[0])
	if err != nil {
		apierror.Write(w, err)
		return
	}
	switch req.Method {
	case http.MethodGet:
		key, err := r.options.Store.GetGenerationKey(ctx, id)
		if err != nil {
			apierror.Write(w, err)
			return
		}
		writeAdminJSON(w, http.StatusOK, map[string]string{"apiKey": r.options.Auth.generationKeys.Issue(key.PublicID, key.Salt)})
	case http.MethodDelete:
		if err := r.options.Store.RevokeGenerationKey(ctx, id); err != nil {
			apierror.Write(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w, "GET, DELETE")
	}
}
