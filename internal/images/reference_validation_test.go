package images_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func TestReferenceDataURIAutoUsesValidatedDimensions(t *testing.T) {
	reader := &fakeReader{err: errors.New("must not decode or fetch again")}
	value := "data:image/png;base64," + base64.StdEncoding.EncodeToString(testutil.PNG(t, 4, 4))
	body, _ := json.Marshal(map[string]any{"model": "m", "prompt": "p", "image": []string{value, value}})
	req := httptest.NewRequest("POST", "/v1/images/edits", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	parsed, err := images.Parse(context.Background(), req, domain.DefaultSettings(), reader)
	if err != nil || parsed.Size.Exact == nil || *parsed.Size.Exact != (domain.PixelSize{Width: 4, Height: 4}) || len(reader.calls) != 0 {
		t.Fatalf("validated dimensions not reused: %+v, %v, calls=%v", parsed.Size, err, reader.calls)
	}
}

func TestMultipartAndDataURIEquivalentValidation(t *testing.T) {
	data := make([]byte, 16<<20)
	copy(data, testutil.PNG(t, 4, 4))
	value := "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	body, _ := json.Marshal(map[string]any{"model": "m", "prompt": "p", "size": "1K", "image": value})
	jsonReq := httptest.NewRequest("POST", "/v1/images/edits", bytes.NewReader(body))
	jsonReq.Header.Set("Content-Type", "application/json")
	if _, err := images.Parse(context.Background(), jsonReq, domain.DefaultSettings(), nil); err != nil {
		t.Fatal("JSON rejected valid decoded 16MiB", err)
	}
	var form bytes.Buffer
	writer := multipart.NewWriter(&form)
	_ = writer.WriteField("model", "m")
	_ = writer.WriteField("prompt", "p")
	_ = writer.WriteField("size", "1K")
	_ = writer.WriteField("image", value)
	_ = writer.Close()
	req := httptest.NewRequest("POST", "/v1/images/edits", &form)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if _, err := images.Parse(context.Background(), req, domain.DefaultSettings(), nil); err != nil {
		t.Fatal("multipart applies limit to encoded rather than decoded bytes", err)
	}
}

func TestReferenceDataURIContentValidation(t *testing.T) {
	png := testutil.PNG(t, 4, 4)
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"data:image/png;base64," + base64.StdEncoding.EncodeToString(png), true},
		{"data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(png), false},
		{"data:image/png;base64,aGk=", false}, {"data:image/png;base64,", false},
		{"data:image/png;base64,@@@@", false}, {"data:image/png;base64,aGk", false},
	} {
		body, _ := json.Marshal(map[string]any{"model": "m", "prompt": "p", "size": "1K", "image": tc.value})
		req := httptest.NewRequest("POST", "/v1/images/edits", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		_, err := images.Parse(context.Background(), req, domain.DefaultSettings(), nil)
		if (err == nil) != tc.valid {
			t.Errorf("reference accepted=%v: %v", tc.valid, err)
		}
	}
}
