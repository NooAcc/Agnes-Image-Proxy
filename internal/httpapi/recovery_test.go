package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

func TestImageRouterAllowsConfiguredCORSPreflight(t *testing.T) {
	handler := httpapi.New(httpapi.Options{Auth: httpapi.NewAuth(httpapi.AuthOptions{APIKey: "key", AllowedOrigins: []string{"https://client.example"}}), Images: service.NewImages(service.ImageOptions{}), Storage: initializedStorage{}})
	for _, path := range []string{"/v1/images/generations", "/v1/images/edits"} {
		req := httptest.NewRequest(http.MethodOptions, path, nil)
		req.Header.Set("Origin", "https://client.example")
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "Authorization, Content-Type")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != "https://client.example" {
			t.Fatalf("preflight %s: %d %v", path, w.Code, w.Header())
		}
	}
}
