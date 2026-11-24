package images_test

import (
	"encoding/json"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

func requestWithSize(t *testing.T, size, ratio string) domain.ImageRequest {
	t.Helper()
	resolved, err := images.ResolveSize(size, ratio, nil, "1K")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	return domain.ImageRequest{
		Endpoint:       "generations",
		Model:          "model-x",
		Prompt:         "draw it",
		N:              5,
		Size:           resolved,
		ResponseFormat: "url",
	}
}

func TestPayloadBasicsAndTier(t *testing.T) {
	req := requestWithSize(t, "2K", "16:9")
	body, err := images.Payload(req, "nested")
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	if body["model"] != "model-x" || body["prompt"] != "draw it" {
		t.Fatalf("body = %v", body)
	}
	if body["n"] != 1 {
		t.Fatalf("n = %v, want 1", body["n"])
	}
	if body["size"] != "2K" || body["ratio"] != "16:9" {
		t.Fatalf("size/ratio = %v %v", body["size"], body["ratio"])
	}
	extra, ok := body["extra_body"].(map[string]any)
	if !ok || extra["response_format"] != "url" {
		t.Fatalf("extra_body = %v", body["extra_body"])
	}
}

func TestPayloadExactSize(t *testing.T) {
	ref := domain.PixelSize{Width: 900, Height: 1200}
	resolved, _ := images.ResolveSize("auto", "", &ref, "1K")
	req := domain.ImageRequest{Model: "m", Prompt: "p", N: 1, Size: resolved, ResponseFormat: "url"}
	body, err := images.Payload(req, "nested")
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	if body["size"] != "900x1200" {
		t.Fatalf("size = %v", body["size"])
	}
}

func TestPayloadImageModes(t *testing.T) {
	req := requestWithSize(t, "1K", "")
	req.Images = []string{"https://a.example/1.png"}

	nested, _ := images.Payload(req, "nested")
	extra := nested["extra_body"].(map[string]any)
	if _, ok := nested["image"]; ok {
		t.Fatalf("nested placed image at top level: %v", nested)
	}
	if images, ok := extra["image"].([]string); !ok || len(images) != 1 {
		t.Fatalf("nested extra image = %v", extra["image"])
	}
	if extra["response_format"] != "url" {
		t.Fatalf("reference response_format = %v", extra["response_format"])
	}

	top, _ := images.Payload(req, "top_level")
	if _, ok := top["image"].([]string); !ok {
		t.Fatalf("top_level image = %v", top["image"])
	}
	if _, ok := top["extra_body"].(map[string]any)["image"]; ok {
		t.Fatalf("top_level duplicated image in extra_body")
	}
}

func TestPayloadBase64Generation(t *testing.T) {
	req := requestWithSize(t, "1K", "")
	req.ResponseFormat = "b64_json"
	body, _ := images.Payload(req, "nested")
	if _, present := body["return_base64"]; present {
		t.Fatal("upstream alias emitted")
	}
	if body["extra_body"].(map[string]any)["response_format"] != "url" {
		t.Fatal("upstream must request URL")
	}
}

func TestPayloadReservedExtraBodyCannotOverride(t *testing.T) {
	req := requestWithSize(t, "1K", "")
	req.ExtraBody = map[string]json.RawMessage{
		"image":           json.RawMessage(`["https://evil.example/x.png"]`),
		"ratio":           json.RawMessage(`"1:1"`),
		"response_format": json.RawMessage(`"b64_json"`),
		"return_base64":   json.RawMessage(`true`),
		"n":               json.RawMessage(`10`),
		"custom":          json.RawMessage(`"keep"`),
	}
	body, err := images.Payload(req, "nested")
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	if body["n"] != 1 {
		t.Fatalf("n overridden: %v", body["n"])
	}
	extra := body["extra_body"].(map[string]any)
	if extra["custom"] != "keep" {
		t.Fatalf("custom extra lost: %v", extra)
	}
	if extra["response_format"] != "url" {
		t.Fatalf("response format overridden: %v", extra["response_format"])
	}
	if _, ok := extra["image"]; ok {
		t.Fatalf("image injected from extra body")
	}
	if _, ok := body["return_base64"]; ok {
		t.Fatalf("return_base64 injected")
	}
}

func TestPayloadRejectsUnknownMode(t *testing.T) {
	req := requestWithSize(t, "1K", "")
	if _, err := images.Payload(req, "sideways"); err == nil {
		t.Fatal("unknown image param mode accepted")
	}
}

func TestNormalize(t *testing.T) {
	raw := json.RawMessage(`{"created":1,"data":[{"url":"https://x.example/a.png","revised_prompt":"ignored"},{"url":"https://x.example/b.png","b64_json":"aGk="}]}`)
	out, err := images.Normalize(raw)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("items = %d", len(out))
	}
	if out[0].URL == nil || *out[0].URL != "https://x.example/a.png" {
		t.Fatalf("item 0 = %+v", out[0])
	}
	if out[1].URL == nil || *out[1].URL != "https://x.example/b.png" {
		t.Fatalf("item 1 = %+v", out[1])
	}
}

func TestNormalizeRejectsMalformed(t *testing.T) {
	for _, raw := range []string{
		`{"data":[]}`,
		`{}`,
		`{"data":[{}]}`,
		`{"data":[{"url":""}]}`,
		`{"data":[{"url":"https://x.example/a.png"},{"url":""}]}`,
		`not json`,
	} {
		if _, err := images.Normalize(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
