package images_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

func TestPayloadAlwaysRequestsURL(t *testing.T) {
	for _, format := range []string{"url", "b64_json"} {
		for _, mode := range []string{"nested", "top_level"} {
			for _, reference := range []bool{false, true} {
				req := domain.ImageRequest{Model: "m", Prompt: "p", N: 3, ResponseFormat: format, Size: domain.ResolvedSize{Tier: "1K"}}
				if reference {
					req.Images = []string{"https://example.com/image.png"}
				}
				body, err := images.Payload(req, mode)
				if err != nil {
					t.Fatal(err)
				}
				extra, ok := body["extra_body"].(map[string]any)
				if !ok || extra["response_format"] != "url" || body["n"] != 1 {
					t.Fatalf("%s/%s/ref=%v: %+v", format, mode, reference, body)
				}
				if _, ok := body["return_base64"]; ok {
					t.Fatal("top-level alias emitted")
				}
				if _, ok := extra["return_base64"]; ok {
					t.Fatal("nested alias emitted")
				}
				if reference {
					_, top := body["image"]
					_, nested := extra["image"]
					if top != (mode == "top_level") || nested != (mode == "nested") {
						t.Fatal("reference position", body)
					}
				}
			}
		}
	}
}
func TestClientFormatHasSingleEntry(t *testing.T) {
	for _, tc := range []struct {
		key, value string
		valid      bool
		format     string
	}{
		{"return_base64", "true", false, ""}, {"return_base64", "false", false, ""},
		{"extra_body", `{"response_format":"url"}`, false, ""}, {"extra_body", `{"return_base64":false}`, false, ""},
		{"response_format", `"url"`, true, "url"}, {"response_format", `"b64_json"`, true, "b64_json"},
		{"response_format", `"invalid"`, false, ""}, {"", "", true, "url"},
	} {
		for _, isMultipart := range []bool{false, true} {
			var body bytes.Buffer
			req := httptest.NewRequest("POST", "/v1/images/generations", nil)
			if isMultipart {
				writer := multipart.NewWriter(&body)
				_ = writer.WriteField("model", "m")
				_ = writer.WriteField("prompt", "p")
				if tc.key != "" {
					value := tc.value
					if tc.key == "response_format" {
						_ = json.Unmarshal([]byte(tc.value), &value)
					}
					_ = writer.WriteField(tc.key, value)
				}
				_ = writer.Close()
				req.Header.Set("Content-Type", writer.FormDataContentType())
			} else {
				obj := map[string]json.RawMessage{"model": json.RawMessage(`"m"`), "prompt": json.RawMessage(`"p"`)}
				if tc.key != "" {
					obj[tc.key] = json.RawMessage(tc.value)
				}
				_ = json.NewEncoder(&body).Encode(obj)
				req.Header.Set("Content-Type", "application/json")
			}
			req.Body = io.NopCloser(&body)
			result, err := images.Parse(context.Background(), req, domain.DefaultSettings(), nil)
			if tc.valid {
				if err != nil || result.ResponseFormat != tc.format {
					t.Fatalf("%s multipart=%v: %+v %v", tc.key, isMultipart, result, err)
				}
			} else {
				var ae *apierror.Error
				if !errors.As(err, &ae) || ae.Status != 400 {
					t.Fatalf("%s multipart=%v accepted: %v", tc.key, isMultipart, err)
				}
				if tc.key != "response_format" && (ae.Code == nil || *ae.Code != "unsupported_parameter") {
					t.Fatalf("wrong rejection: %+v", ae)
				}
			}
		}
	}
}
func TestNormalizeURLContract(t *testing.T) {
	for _, tc := range []struct {
		item  string
		valid bool
	}{
		{`{"url":"https://example.com/image.png"}`, true}, {`{"url":"http://127.0.0.1:8080/image.png"}`, true},
		{`{"url":"http://localhost:8080/image.png"}`, true}, {`{"url":"http://[::1]:8080/image.png"}`, true},
		{`{"url":"http://example.com/image.png"}`, false}, {`{"url":""}`, false}, {`{"url":" "}`, false},
		{`{"url":"not a URL"}`, false}, {`{"url":"data:image/png;base64,aGk="}`, false}, {`{"url":"javascript:alert(1)"}`, false},
		{`{"url":"https://user:pass@example.com/image.png"}`, false}, {`{"b64_json":"aGk="}`, false},
		{`{"url":"https://example.com/image.png","b64_json":"invalid base64"}`, true},
	} {
		result, err := images.Normalize(json.RawMessage(`{"data":[` + tc.item + `]}`))
		if (err == nil) != tc.valid {
			t.Errorf("%s: %v", tc.item, err)
		}
		if tc.valid && (len(result) != 1 || result[0].URL == nil) {
			t.Errorf("URL-only contract: %+v", result)
		}
	}
}
