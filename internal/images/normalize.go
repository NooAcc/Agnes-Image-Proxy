package images

import (
	"encoding/json"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

var reservedExtraKeys = map[string]bool{
	"image":           true,
	"ratio":           true,
	"response_format": true,
	"return_base64":   true,
	"n":               true,
}

// Payload builds the Agnes request body. The upstream endpoint is always
// /images/generations, n is always 1 and reserved extra_body keys can never
// override parsed values.
func Payload(req domain.ImageRequest, mode string) (map[string]any, error) {
	if mode != "nested" && mode != "top_level" {
		return nil, apierror.Invalid("imageParamMode", "imageParamMode must be nested or top_level", "invalid_value")
	}

	body := map[string]any{
		"model":  req.Model,
		"prompt": req.Prompt,
		"n":      1,
	}
	if req.Size.Exact != nil {
		body["size"] = FormatPixel(*req.Size.Exact)
	} else {
		body["size"] = req.Size.Tier
	}
	if req.Size.Ratio != nil {
		body["ratio"] = *req.Size.Ratio
	}

	extra := make(map[string]any)
	for key, raw := range req.ExtraBody {
		if reservedExtraKeys[key] {
			continue
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, apierror.Invalid("extra_body", "extra_body contains invalid JSON", "invalid_value")
		}
		extra[key] = value
	}

	switch {
	case len(req.Images) > 0:
		if mode == "top_level" {
			body["image"] = req.Images
		} else {
			extra["image"] = req.Images
		}
		extra["response_format"] = req.ResponseFormat
	case req.ResponseFormat == "b64_json":
		body["return_base64"] = true
	default:
		extra["response_format"] = "url"
	}

	if len(extra) > 0 {
		body["extra_body"] = extra
	}
	return body, nil
}

// Normalize extracts output images from an upstream Agnes response. At least
// one usable image is required; empty strings become nil.
func Normalize(raw json.RawMessage) ([]domain.OutputImage, error) {
	var payload struct {
		Data []struct {
			URL    *string `json:"url"`
			Base64 *string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || len(payload.Data) == 0 {
		return nil, missingImages()
	}

	out := make([]domain.OutputImage, 0, len(payload.Data))
	for _, item := range payload.Data {
		image := domain.OutputImage{URL: cleanOptional(item.URL), Base64: cleanOptional(item.Base64)}
		if image.URL == nil && image.Base64 == nil {
			return nil, missingImages()
		}
		out = append(out, image)
	}
	return out, nil
}

func cleanOptional(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

func missingImages() error {
	return apierror.Coded(502, "upstream response is missing images", "server_error", "invalid_upstream_response")
}
