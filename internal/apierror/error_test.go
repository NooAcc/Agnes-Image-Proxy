package apierror_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

func TestWriteEnvelope(t *testing.T) {
	param := "size"
	code := "invalid_size"
	err := &apierror.Error{
		Status:  http.StatusBadRequest,
		Message: "bad size",
		Type:    "invalid_request_error",
		Param:   &param,
		Code:    &code,
		Headers: http.Header{"Retry-After": []string{"60"}},
	}
	rec := httptest.NewRecorder()
	apierror.Write(rec, err)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") != "60" {
		t.Fatalf("missing Retry-After header")
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content type = %q", ct)
	}
	var body struct {
		Error struct {
			Message string  `json:"message"`
			Type    string  `json:"type"`
			Param   *string `json:"param"`
			Code    *string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if body.Error.Message != "bad size" || body.Error.Type != "invalid_request_error" {
		t.Fatalf("unexpected envelope: %+v", body.Error)
	}
	if body.Error.Param == nil || *body.Error.Param != "size" || body.Error.Code == nil || *body.Error.Code != "invalid_size" {
		t.Fatalf("unexpected param/code: %+v", body.Error)
	}
}

func TestWriteHidesInternalErrors(t *testing.T) {
	rec := httptest.NewRecorder()
	apierror.Write(rec, errors.New("db password=hunter2"))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "hunter2") {
		t.Fatalf("internal error leaked: %s", rec.Body.String())
	}
}
