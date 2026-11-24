package images_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

type fakeReader struct {
	size  domain.PixelSize
	err   error
	calls []string
}

func (f *fakeReader) Dimensions(_ context.Context, source string) (domain.PixelSize, error) {
	f.calls = append(f.calls, source)
	if f.err != nil {
		return domain.PixelSize{}, f.err
	}
	return f.size, nil
}

func parseJSON(t *testing.T, path, body string, reader images.ReferenceReader) (domain.ImageRequest, error) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return images.Parse(context.Background(), req, domain.DefaultSettings(), reader)
}

func mustStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *apierror.Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected apierror, got %T: %v", err, err)
	}
	if apiErr.Status != status {
		t.Fatalf("status = %d, want %d (%v)", apiErr.Status, status, err)
	}
}

func TestParseJSONAutoReadsReference(t *testing.T) {
	reader := &fakeReader{size: domain.PixelSize{Width: 900, Height: 1200}}
	got, err := parseJSON(t, "/v1/images/generations", `{"model":"m","prompt":"p","image":"https://images.example/a.png"}`, reader)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.Endpoint != "generations" || got.N != 1 || got.Model != "m" || got.Prompt != "p" {
		t.Fatalf("unexpected request: %+v", got)
	}
	if got.Size.Mode != "exact" || got.Size.Exact == nil || got.Size.Exact.Width != 900 {
		t.Fatalf("auto size not exact: %+v", got.Size)
	}
	if len(reader.calls) != 1 || reader.calls[0] != "https://images.example/a.png" {
		t.Fatalf("reader calls = %v", reader.calls)
	}
}

func TestParseJSONExplicitSizeSkipsReference(t *testing.T) {
	reader := &fakeReader{err: errors.New("must not be called")}
	got, err := parseJSON(t, "/v1/images/edits", `{"model":"m","prompt":"p","size":"2K","image":"https://images.example/a.png"}`, reader)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.Endpoint != "edits" || got.Size.Tier != "2K" || got.Size.Mode != "tier" {
		t.Fatalf("unexpected request: %+v", got)
	}
	if len(reader.calls) != 0 {
		t.Fatalf("reference read for explicit size: %v", reader.calls)
	}
}

func TestParseJSONAutoReferenceFailure(t *testing.T) {
	reader := &fakeReader{err: errors.New("unreadable")}
	_, err := parseJSON(t, "/v1/images/generations", `{"model":"m","prompt":"p","image":"https://images.example/a.png"}`, reader)
	mustStatus(t, err, 400)
}

func TestParseJSONUnsupportedParameters(t *testing.T) {
	base := `{"model":"m","prompt":"p"%s}`
	cases := []string{
		`,"mask":"https://example.com/m.png"`,
		`,"stream":true`,
		`,"file_id":"file_123"`,
		`,"partial_images":2`,
	}
	for _, extra := range cases {
		_, err := parseJSON(t, "/v1/images/generations", fmt.Sprintf(base, extra), nil)
		mustStatus(t, err, 400)
	}
	if _, err := parseJSON(t, "/v1/images/generations", fmt.Sprintf(base, `,"stream":false`), nil); err != nil {
		t.Fatalf("stream=false rejected: %v", err)
	}
}

func TestParseJSONCount(t *testing.T) {
	if got, err := parseJSON(t, "/v1/images/generations", `{"model":"m","prompt":"p","n":11}`, nil); err != nil || got.N != 11 {
		t.Fatalf("n=11 rejected: %v %+v", err, got)
	}
	for _, raw := range []string{"0", "-1", "1.5", `"5"`, "99999999999999999999999", "1e3"} {
		body := fmt.Sprintf(`{"model":"m","prompt":"p","n":%s}`, raw)
		_, err := parseJSON(t, "/v1/images/generations", body, nil)
		mustStatus(t, err, 400)
	}
}

func TestParseJSONStrictSingleObject(t *testing.T) {
	for _, body := range []string{
		`{"model":"m","prompt":"p"}{"model":"x"}`,
		`[{"model":"m","prompt":"p"}]`,
		`null`,
	} {
		_, err := parseJSON(t, "/v1/images/generations", body, nil)
		mustStatus(t, err, 400)
	}
}

func TestParseJSONRequiresModelAndPrompt(t *testing.T) {
	for _, body := range []string{
		`{"prompt":"p"}`,
		`{"model":"","prompt":"p"}`,
		`{"model":"m"}`,
		`{"model":"m","prompt":"   "}`,
	} {
		_, err := parseJSON(t, "/v1/images/generations", body, nil)
		mustStatus(t, err, 400)
	}
}

func TestParseJSONWarningsDeduplicated(t *testing.T) {
	got, err := parseJSON(t, "/v1/images/generations",
		`{"model":"m","prompt":"p","quality":"hd","unknown_field":1,"foo":true,"quality":"low"}`, nil)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := []string{"quality", "foo", "unknown_field"}
	if len(got.Warnings) != len(want) {
		t.Fatalf("warnings = %v", got.Warnings)
	}
	for i := range want {
		if got.Warnings[i] != want[i] {
			t.Fatalf("warnings = %v", got.Warnings)
		}
	}
}

func TestParseJSONImageForms(t *testing.T) {
	got, err := parseJSON(t, "/v1/images/generations",
		`{"model":"m","prompt":"p","size":"1K","image":["https://a.example/1.png",{"image_url":"https://a.example/2.png"}],"images":"https://a.example/3.png"}`, nil)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := []string{"https://a.example/1.png", "https://a.example/2.png", "https://a.example/3.png"}
	if len(got.Images) != len(want) {
		t.Fatalf("images = %v", got.Images)
	}
	for i := range want {
		if got.Images[i] != want[i] {
			t.Fatalf("images = %v", got.Images)
		}
	}

	_, err = parseJSON(t, "/v1/images/generations",
		`{"model":"m","prompt":"p","size":"1K","image":[{"file_id":"file_1"}]}`, nil)
	mustStatus(t, err, 400)

	_, err = parseJSON(t, "/v1/images/generations",
		`{"model":"m","prompt":"p","size":"1K","image":"ftp://example.com/a.png"}`, nil)
	mustStatus(t, err, 400)

	_, err = parseJSON(t, "/v1/images/generations",
		`{"model":"m","prompt":"p","size":"1K","image":"https://user:pass@example.com/a.png"}`, nil)
	mustStatus(t, err, 400)

	_, err = parseJSON(t, "/v1/images/generations",
		`{"model":"m","prompt":"p","size":"1K","image":"data:image/gif;base64,R0lGODlhAQABAAAAACw="}`, nil)
	mustStatus(t, err, 400)
}

func TestParseJSONTooManyImages(t *testing.T) {
	parts := make([]string, 17)
	for i := range parts {
		parts[i] = fmt.Sprintf(`"https://a.example/%d.png"`, i)
	}
	body := fmt.Sprintf(`{"model":"m","prompt":"p","size":"1K","image":[%s]}`, strings.Join(parts, ","))
	_, err := parseJSON(t, "/v1/images/generations", body, nil)
	mustStatus(t, err, 400)
}

func TestParseJSONDataURIAccepted(t *testing.T) {
	dataURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(testutil.PNG(t, 2, 2))
	got, err := parseJSON(t, "/v1/images/generations",
		fmt.Sprintf(`{"model":"m","prompt":"p","image":%q}`, dataURI), &fakeReader{size: domain.PixelSize{Width: 2, Height: 2}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got.Images) != 1 || !strings.HasPrefix(got.Images[0], "data:image/png;base64,") {
		t.Fatalf("images = %v", got.Images)
	}
}

func TestParseJSONBodyLimit(t *testing.T) {
	body := `{"model":"m","prompt":"` + strings.Repeat("x", 32<<20) + `"}`
	_, err := parseJSON(t, "/v1/images/generations", body, nil)
	mustStatus(t, err, 413)
}

func TestParseJSONExtraBodyImage(t *testing.T) {
	got, err := parseJSON(t, "/v1/images/generations",
		`{"model":"m","prompt":"p","size":"1K","extra_body":{"image":["https://a.example/1.png"],"custom":1}}`, nil)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got.Images) != 1 || got.Images[0] != "https://a.example/1.png" {
		t.Fatalf("images = %v", got.Images)
	}
	if _, ok := got.ExtraBody["custom"]; !ok {
		t.Fatalf("extra body lost: %v", got.ExtraBody)
	}
}

func TestParseResponseFormat(t *testing.T) {
	got, err := parseJSON(t, "/v1/images/generations", `{"model":"m","prompt":"p"}`, nil)
	if err != nil || got.ResponseFormat != "url" {
		t.Fatalf("default format: %v %+v", err, got)
	}
	got, err = parseJSON(t, "/v1/images/generations", `{"model":"m","prompt":"p","return_base64":true}`, nil)
	if err != nil || got.ResponseFormat != "b64_json" {
		t.Fatalf("return_base64: %v %+v", err, got)
	}
	got, err = parseJSON(t, "/v1/images/generations", `{"model":"m","prompt":"p","response_format":"b64_json"}`, nil)
	if err != nil || got.ResponseFormat != "b64_json" {
		t.Fatalf("response_format: %v %+v", err, got)
	}
	_, err = parseJSON(t, "/v1/images/generations", `{"model":"m","prompt":"p","response_format":"webp"}`, nil)
	mustStatus(t, err, 400)
	_, err = parseJSON(t, "/v1/images/generations", `{"model":"m","prompt":"p","return_base64":"yes"}`, nil)
	mustStatus(t, err, 400)
}

func multipartRequest(t *testing.T, fields map[string]string, files []struct {
	field string
	name  string
	ctype string
	data  []byte
}) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("field: %v", err)
		}
	}
	for _, file := range files {
		header := make(map[string][]string)
		header["Content-Disposition"] = []string{fmt.Sprintf(`form-data; name=%q; filename=%q`, file.field, file.name)}
		if file.ctype != "" {
			header["Content-Type"] = []string{file.ctype}
		}
		part, err := writer.CreatePart(header)
		if err != nil {
			t.Fatalf("part: %v", err)
		}
		if _, err := part.Write(file.data); err != nil {
			t.Fatalf("write part: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

func TestParseMultipart(t *testing.T) {
	reader := &fakeReader{size: domain.PixelSize{Width: 3, Height: 4}}
	req := multipartRequest(t, map[string]string{"model": "m", "prompt": "p"}, []struct {
		field string
		name  string
		ctype string
		data  []byte
	}{{"image", "a.png", "image/png", testutil.PNG(t, 3, 4)}})
	got, err := images.Parse(context.Background(), req, domain.DefaultSettings(), reader)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got.Images) != 1 || !strings.HasPrefix(got.Images[0], "data:image/png;base64,") {
		t.Fatalf("images = %v", got.Images)
	}
	if got.Size.Mode != "exact" || got.Size.Exact == nil || got.Size.Exact.Width != 3 {
		t.Fatalf("auto size not read from reference: %+v", got.Size)
	}
	if len(reader.calls) != 1 || !strings.HasPrefix(reader.calls[0], "data:image/png;base64,") {
		t.Fatalf("reader calls = %v", reader.calls)
	}
}

func TestParseMultipartRejectsNonImage(t *testing.T) {
	req := multipartRequest(t, map[string]string{"model": "m", "prompt": "p"}, []struct {
		field string
		name  string
		ctype string
		data  []byte
	}{{"image", "a.gif", "image/gif", []byte("GIF89a")}})
	_, err := images.Parse(context.Background(), req, domain.DefaultSettings(), nil)
	mustStatus(t, err, 400)
}

func TestParseMultipartDeclaredTypeMismatch(t *testing.T) {
	req := multipartRequest(t, map[string]string{"model": "m", "prompt": "p"}, []struct {
		field string
		name  string
		ctype string
		data  []byte
	}{{"image", "a.png", "image/jpeg", testutil.PNG(t, 2, 2)}})
	_, err := images.Parse(context.Background(), req, domain.DefaultSettings(), nil)
	mustStatus(t, err, 400)
}

func TestParseMultipartImageTooLarge(t *testing.T) {
	data := append(testutil.PNG(t, 2, 2), make([]byte, 20<<20)...)
	req := multipartRequest(t, map[string]string{"model": "m", "prompt": "p"}, []struct {
		field string
		name  string
		ctype string
		data  []byte
	}{{"image", "a.png", "image/png", data}})
	_, err := images.Parse(context.Background(), req, domain.DefaultSettings(), nil)
	mustStatus(t, err, 400)
}

func TestParseMultipartTooManyImages(t *testing.T) {
	files := make([]struct {
		field string
		name  string
		ctype string
		data  []byte
	}, 17)
	for i := range files {
		files[i] = struct {
			field string
			name  string
			ctype string
			data  []byte
		}{"image", fmt.Sprintf("%d.png", i), "image/png", testutil.PNG(t, 1, 1)}
	}
	req := multipartRequest(t, map[string]string{"model": "m", "prompt": "p"}, files)
	_, err := images.Parse(context.Background(), req, domain.DefaultSettings(), nil)
	mustStatus(t, err, 400)
}

func TestParseMultipartTotalLimit(t *testing.T) {
	big := append(testutil.PNG(t, 2, 2), make([]byte, 17<<20)...)
	req := multipartRequest(t, map[string]string{"model": "m", "prompt": "p"}, []struct {
		field string
		name  string
		ctype string
		data  []byte
	}{{"image", "a.png", "image/png", big}, {"image", "b.png", "image/png", big}})
	_, err := images.Parse(context.Background(), req, domain.DefaultSettings(), nil)
	mustStatus(t, err, 413)
}

func TestParseRejectsUnsupportedContentType(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader("x"))
	req.Header.Set("Content-Type", "text/plain")
	_, err := images.Parse(context.Background(), req, domain.DefaultSettings(), nil)
	mustStatus(t, err, 400)
}
