// Package apierror defines the HTTP error envelope shared by the data and
// admin APIs. It never exposes internal transport or database details.
package apierror

import (
	"encoding/json"
	"errors"
	"net/http"
)

// Error is an HTTP error carrying the OpenAI-compatible envelope fields.
type Error struct {
	Status  int
	Message string
	Type    string
	Param   *string
	Code    *string
	Headers http.Header
}

func (e *Error) Error() string { return e.Message }

// WithHeader adds a response header to the error and returns it for chaining.
func (e *Error) WithHeader(key, value string) *Error {
	if e.Headers == nil {
		e.Headers = make(http.Header)
	}
	e.Headers.Set(key, value)
	return e
}

// New builds an error with the given status, message and OpenAI error type.
func New(status int, message, typ string) *Error {
	return &Error{Status: status, Message: message, Type: typ}
}

// Invalid builds a 400 invalid_request_error for a request field.
func Invalid(param, message, code string) *Error {
	e := New(http.StatusBadRequest, message, "invalid_request_error")
	e.Param = &param
	if code != "" {
		e.Code = &code
	}
	return e
}

// Coded builds an error with an explicit machine-readable code.
func Coded(status int, message, typ, code string) *Error {
	e := New(status, message, typ)
	e.Code = &code
	return e
}

type envelope struct {
	Error payload `json:"error"`
}

type payload struct {
	Message string  `json:"message"`
	Type    string  `json:"type"`
	Param   *string `json:"param"`
	Code    *string `json:"code"`
}

// Write renders err as the OpenAI error envelope. Unknown error values become
// a generic 500 so internal details never reach the client.
func Write(w http.ResponseWriter, err error) {
	e := &Error{Status: http.StatusInternalServerError, Message: "internal server error", Type: "server_error"}
	var apiErr *Error
	if errors.As(err, &apiErr) {
		e = apiErr
	}
	for key, values := range e.Headers {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(e.Status)
	_ = json.NewEncoder(w).Encode(envelope{Error: payload{
		Message: e.Message,
		Type:    e.Type,
		Param:   e.Param,
		Code:    e.Code,
	}})
}
