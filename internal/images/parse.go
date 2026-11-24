package images

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const (
	MaxInputImages     = 16
	MaxInputImageBytes = 20 << 20
	MaxRequestBytes    = 32 << 20
)

// ReferenceReader resolves the pixel size of a reference image. Production
// uses *Remote; tests provide a fake.
type ReferenceResolver interface {
	ResolveReference(context.Context, string) (string, error)
}

// BudgetReferenceResolver preflights local originals before loading their BLOB.
// The limit includes the normalized reference's JSON string representation.
type BudgetReferenceResolver interface {
	ResolveReferenceWithinBudget(context.Context, string, int) (string, error)
}

type ReferenceReader interface {
	Dimensions(context.Context, string) (domain.PixelSize, error)
}

var ignoredFields = []string{
	"quality",
	"background",
	"output_format",
	"output_compression",
	"moderation",
	"style",
	"input_fidelity",
	"user",
	"safety_identifier",
}

var knownFields = map[string]bool{
	"model": true, "prompt": true, "n": true, "size": true, "ratio": true,
	"response_format": true, "return_base64": true, "extra_body": true,
	"stream": true, "partial_images": true, "image": true, "images": true,
	"file_id": true, "mask": true,
}

func init() {
	for _, field := range ignoredFields {
		knownFields[field] = true
	}
}

// Parse validates and parses an image generation or edit request.
func Parse(ctx context.Context, r *http.Request, defaults domain.Settings, reader ReferenceReader) (domain.ImageRequest, error) {
	endpoint := "generations"
	if strings.HasSuffix(strings.TrimRight(r.URL.Path, "/"), "/edits") {
		endpoint = "edits"
	}

	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return domain.ImageRequest{}, invalidBody("request body is not valid JSON")
	}
	switch mediaType {
	case "application/json":
		return parseJSON(ctx, r.Body, endpoint, defaults, reader)
	case "multipart/form-data":
		return parseMultipart(ctx, r, endpoint, defaults, reader)
	default:
		return domain.ImageRequest{}, invalidBody("unsupported content type")
	}
}

func parseJSON(ctx context.Context, body io.Reader, endpoint string, defaults domain.Settings, reader ReferenceReader) (domain.ImageRequest, error) {
	data, err := io.ReadAll(io.LimitReader(body, MaxRequestBytes+1))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return domain.ImageRequest{}, requestTooLarge()
		}
		return domain.ImageRequest{}, invalidBody("request body could not be read")
	}
	if len(data) > MaxRequestBytes {
		return domain.ImageRequest{}, requestTooLarge()
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	var obj map[string]json.RawMessage
	if err := decoder.Decode(&obj); err != nil || obj == nil {
		return domain.ImageRequest{}, invalidBody("request body must be a JSON object")
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		return domain.ImageRequest{}, invalidBody("request body must contain a single JSON object")
	}
	return buildRequest(ctx, obj, endpoint, defaults, reader)
}

func buildRequest(ctx context.Context, obj map[string]json.RawMessage, endpoint string, defaults domain.Settings, reader ReferenceReader) (domain.ImageRequest, error) {
	if err := rejectUnsupported(obj); err != nil {
		return domain.ImageRequest{}, err
	}

	model, err := requiredString(obj, "model")
	if err != nil {
		return domain.ImageRequest{}, err
	}
	prompt, err := requiredString(obj, "prompt")
	if err != nil {
		return domain.ImageRequest{}, err
	}

	n := int64(1)
	if raw, ok := obj["n"]; ok {
		trimmed := strings.TrimSpace(string(raw))
		if trimmed == "" || trimmed[0] == '"' || trimmed[0] == '+' || trimmed[0] == '.' {
			return domain.ImageRequest{}, invalidParam("n", "n must be a positive integer", "invalid_value")
		}
		var number json.Number
		if err := json.Unmarshal(raw, &number); err != nil {
			return domain.ImageRequest{}, invalidParam("n", "n must be a positive integer", "invalid_value")
		}
		value, err := number.Int64()
		if err != nil || value < 1 {
			return domain.ImageRequest{}, invalidParam("n", "n must be a positive integer", "invalid_value")
		}
		n = value
	}

	rawSize, err := optionalString(obj, "size")
	if err != nil {
		return domain.ImageRequest{}, err
	}
	rawRatio, err := optionalString(obj, "ratio")
	if err != nil {
		return domain.ImageRequest{}, err
	}

	extraBody, err := parseExtraBody(obj["extra_body"])
	if err != nil {
		return domain.ImageRequest{}, err
	}

	for _, field := range []string{"response_format", "return_base64"} {
		if _, present := extraBody[field]; present {
			return domain.ImageRequest{}, invalidParam("extra_body."+field, "output format controls are not supported in extra_body", "unsupported_parameter")
		}
	}
	images, referenceSizes, err := collectImages(obj, extraBody)
	if err != nil {
		return domain.ImageRequest{}, err
	}

	normalizedBytes := 2 // JSON array brackets.
	for i, value := range images {
		if i > 0 {
			normalizedBytes++
		}
		remaining := MaxRequestBytes - normalizedBytes
		if resolver, ok := reader.(BudgetReferenceResolver); ok {
			value, err = resolver.ResolveReferenceWithinBudget(ctx, value, remaining)
		} else if resolver, ok := reader.(ReferenceResolver); ok {
			value, err = resolver.ResolveReference(ctx, value)
		}
		if err != nil {
			return domain.ImageRequest{}, err
		}
		encoded, err := json.Marshal(value)
		if err != nil || len(encoded) > remaining {
			return domain.ImageRequest{}, invalidParam("image", "normalized reference images are too large", "image_too_large")
		}
		normalizedBytes += len(encoded)
		images[i] = value
	}
	responseFormat, err := readResponseFormat(obj)
	if err != nil {
		return domain.ImageRequest{}, err
	}

	trimmedSize := strings.TrimSpace(rawSize)
	isAuto := trimmedSize == "" || strings.EqualFold(trimmedSize, "auto")

	var size domain.ResolvedSize
	switch {
	case isAuto && len(images) > 0:
		var reference domain.PixelSize
		if validated, ok := referenceSizes[images[0]]; ok {
			if validated.Width < 1 || validated.Height < 1 {
				return domain.ImageRequest{}, unreadableReference()
			}
			reference = validated
		} else {
			if reader == nil {
				return domain.ImageRequest{}, unreadableReference()
			}
			reference, err = reader.Dimensions(ctx, images[0])
			if err != nil {
				return domain.ImageRequest{}, unreadableReference()
			}
		}
		size, err = ResolveSize("auto", strings.TrimSpace(rawRatio), &reference, defaults.DefaultSize)
		if err != nil {
			return domain.ImageRequest{}, err
		}
	case isAuto:
		size, err = ResolveSize(defaults.DefaultSize, strings.TrimSpace(rawRatio), nil, defaults.DefaultSize)
		if err != nil {
			return domain.ImageRequest{}, err
		}
	default:
		size, err = ResolveSize(trimmedSize, strings.TrimSpace(rawRatio), nil, defaults.DefaultSize)
		if err != nil {
			return domain.ImageRequest{}, err
		}
	}

	return domain.ImageRequest{
		Endpoint:       endpoint,
		Model:          model,
		Prompt:         prompt,
		N:              n,
		Size:           size,
		ResponseFormat: responseFormat,
		Images:         images,
		Warnings:       collectWarnings(obj),
		ExtraBody:      extraBody,
	}, nil
}

func rejectUnsupported(obj map[string]json.RawMessage) error {
	if _, ok := obj["return_base64"]; ok {
		return invalidParam("return_base64", "return_base64 is not supported; use response_format", "unsupported_parameter")
	}
	if raw, ok := obj["stream"]; ok {
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil {
			return invalidParam("stream", "stream must be a boolean", "invalid_value")
		}
		if value {
			return invalidParam("stream", "stream is not supported", "unsupported_parameter")
		}
	}
	if _, ok := obj["partial_images"]; ok {
		return invalidParam("partial_images", "partial_images is not supported", "unsupported_parameter")
	}
	if _, ok := obj["mask"]; ok {
		return invalidParam("mask", "mask is not supported", "unsupported_parameter")
	}
	if _, ok := obj["file_id"]; ok {
		return invalidParam("file_id", "file_id is not supported", "unsupported_parameter")
	}
	return nil
}

func requiredString(obj map[string]json.RawMessage, field string) (string, error) {
	value, err := optionalString(obj, field)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(value) == "" {
		return "", invalidParam(field, field+" is required", "missing_parameter")
	}
	if field == "model" {
		return strings.TrimSpace(value), nil
	}
	return value, nil
}

func optionalString(obj map[string]json.RawMessage, field string) (string, error) {
	raw, ok := obj[field]
	if !ok {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", invalidParam(field, field+" must be a string", "invalid_value")
	}
	return value, nil
}

func parseExtraBody(raw json.RawMessage) (map[string]json.RawMessage, error) {
	extra := make(map[string]json.RawMessage)
	if len(raw) == 0 {
		return extra, nil
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return nil, invalidParam("extra_body", "extra_body must be an object", "invalid_value")
	}
	for key, item := range value {
		extra[key] = item
	}
	return extra, nil
}

func collectImages(obj map[string]json.RawMessage, extraBody map[string]json.RawMessage) ([]string, map[string]domain.PixelSize, error) {
	var raw []string
	for _, field := range []string{"image", "images"} {
		if value, ok := obj[field]; ok {
			images, err := readImageValue(value, field)
			if err != nil {
				return nil, nil, err
			}
			raw = append(raw, images...)
		}
	}
	if value, ok := extraBody["image"]; ok {
		images, err := readImageValue(value, "image")
		if err != nil {
			return nil, nil, err
		}
		raw = append(raw, images...)
	}
	if len(raw) > MaxInputImages {
		return nil, nil, invalidParam("image", "at most 16 images are allowed", "too_many_images")
	}
	out := make([]string, 0, len(raw))
	sizes := make(map[string]domain.PixelSize)
	normalizedValues := make(map[string]string)
	for _, value := range raw {
		value = strings.TrimSpace(value)
		if normalized, ok := normalizedValues[value]; ok {
			out = append(out, normalized)
			continue
		}
		var normalized string
		if strings.HasPrefix(strings.ToLower(value), "data:") {
			mime, data, err := DecodeImageDataURI(value, MaxInputImageBytes)
			if err != nil {
				return nil, nil, invalidParam("image", "reference data URI is unsupported; use png, jpeg or webp with base64 encoding", "unsupported_parameter")
			}
			normalized = "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
			if size, err := ImageDimensions(data); err == nil {
				sizes[normalized] = size
			} else {
				// Remember a failed header read too: auto must not decode again.
				sizes[normalized] = domain.PixelSize{}
			}
		} else {
			var err error
			normalized, err = validateImageReference(value)
			if err != nil {
				return nil, nil, err
			}
		}
		normalizedValues[value] = normalized
		out = append(out, normalized)
	}
	return out, sizes, nil
}

func readImageValue(raw json.RawMessage, field string) ([]string, error) {
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		if single == "" {
			return nil, nil
		}
		return []string{single}, nil
	}

	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, invalidParam(field, field+" must be a string or an array of images", "unsupported_parameter")
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		var value string
		if err := json.Unmarshal(item, &value); err == nil {
			if value != "" {
				out = append(out, value)
			}
			continue
		}
		var entry map[string]json.RawMessage
		if err := json.Unmarshal(item, &entry); err != nil {
			return nil, invalidParam(field, field+" entries must be strings or {image_url}", "unsupported_parameter")
		}
		if _, ok := entry["file_id"]; ok {
			return nil, invalidParam(field, "file_id is not supported", "unsupported_parameter")
		}
		if value, ok := imageURLFromEntry(entry); ok {
			out = append(out, value)
			continue
		}
		return nil, invalidParam(field, field+" entries must be strings or {image_url}", "unsupported_parameter")
	}
	return out, nil
}

func imageURLFromEntry(entry map[string]json.RawMessage) (string, bool) {
	for _, key := range []string{"image_url", "url"} {
		raw, ok := entry[key]
		if !ok {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err == nil && value != "" {
			return value, true
		}
		var nested map[string]json.RawMessage
		if err := json.Unmarshal(raw, &nested); err == nil {
			if urlRaw, ok := nested["url"]; ok {
				if err := json.Unmarshal(urlRaw, &value); err == nil && value != "" {
					return value, true
				}
			}
		}
	}
	return "", false
}

func validateImageReference(value string) (string, error) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(strings.ToLower(value), "data:") {
		mime, payload, _, ok := parseDataURI(value)
		if !ok {
			return "", invalidParam("image", "reference data URI is unsupported; use png, jpeg or webp with base64 encoding", "unsupported_parameter")
		}
		return "data:" + mime + ";base64," + payload, nil
	}

	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return "", invalidParam("image", "reference images must be http(s) URLs or data URIs", "unsupported_parameter")
	}
	return value, nil
}

func readResponseFormat(obj map[string]json.RawMessage) (string, error) {
	format := "url"
	if raw, ok := obj["response_format"]; ok {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil || (value != "url" && value != "b64_json") {
			return "", invalidParam("response_format", "response_format must be url or b64_json", "invalid_value")
		}
		format = value
	}
	return format, nil
}

func collectWarnings(obj map[string]json.RawMessage) []string {
	seen := make(map[string]bool)
	var warnings []string
	add := func(field string) {
		if seen[field] {
			return
		}
		seen[field] = true
		warnings = append(warnings, field)
	}
	for _, field := range ignoredFields {
		if _, ok := obj[field]; ok {
			add(field)
		}
	}
	var unknown []string
	for key := range obj {
		if !knownFields[key] {
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	for _, key := range unknown {
		add(key)
	}
	return warnings
}

func invalidBody(message string) error {
	return apierror.Coded(400, message, "invalid_request_error", "invalid_body")
}

func invalidParam(param, message, code string) error {
	return apierror.Invalid(param, message, code)
}

func requestTooLarge() error {
	return apierror.Coded(413, "request body is too large", "invalid_request_error", "request_too_large")
}

func unreadableReference() error {
	return apierror.Invalid("image", "reference image dimensions could not be read", "reference_image_unsupported")
}
