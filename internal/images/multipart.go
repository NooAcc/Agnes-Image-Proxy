package images

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

var errRequestTooLarge = errors.New("request body is too large")

func parseMultipart(ctx context.Context, r *http.Request, endpoint string, defaults domain.Settings, reader ReferenceReader) (domain.ImageRequest, error) {
	r.Body = &boundedBody{reader: r.Body, remaining: MaxRequestBytes}
	multipartReader, err := r.MultipartReader()
	if err != nil {
		return domain.ImageRequest{}, invalidBody("request body is not valid multipart/form-data")
	}

	fields := make(map[string]json.RawMessage)
	var images []string

	for {
		part, err := multipartReader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if errors.Is(err, errRequestTooLarge) {
				return domain.ImageRequest{}, requestTooLarge()
			}
			return domain.ImageRequest{}, invalidBody("request body is not valid multipart/form-data")
		}

		name := part.FormName()
		filename := part.FileName()
		switch {
		case name == "mask":
			return domain.ImageRequest{}, invalidParam("mask", "mask is not supported", "unsupported_parameter")
		case name == "file_id":
			return domain.ImageRequest{}, invalidParam("file_id", "file_id is not supported", "unsupported_parameter")
		case name == "image" || name == "image[]" || name == "images":
			limit := int64(MaxInputImageBytes)
			if filename == "" {
				limit = int64(base64.StdEncoding.EncodedLen(MaxInputImageBytes) + 64)
			}
			data, tooLarge, err := readLimitedPart(part, limit)
			if err != nil {
				if errors.Is(err, errRequestTooLarge) {
					return domain.ImageRequest{}, requestTooLarge()
				}
				return domain.ImageRequest{}, invalidBody("multipart image could not be read")
			}
			if tooLarge {
				return domain.ImageRequest{}, invalidParam("image", "input image is too large", "image_too_large")
			}
			if filename == "" {
				value := strings.TrimSpace(string(data))
				if value == "" {
					continue
				}
				images = append(images, value)
			} else {
				sniffed := SniffImage(data)
				if sniffed == "" {
					return domain.ImageRequest{}, invalidParam("image", "unsupported image type (expected png, jpeg or webp)", "unsupported_parameter")
				}
				if declared := part.Header.Get("Content-Type"); declared != "" {
					if contentType, _, err := mime.ParseMediaType(declared); err == nil && strings.HasPrefix(contentType, "image/") {
						if normalizeImageMIME(contentType) != sniffed {
							return domain.ImageRequest{}, invalidParam("image", "declared image type does not match image contents", "unsupported_parameter")
						}
					}
				}
				images = append(images, "data:"+sniffed+";base64,"+base64.StdEncoding.EncodeToString(data))
			}
			if len(images) > MaxInputImages {
				return domain.ImageRequest{}, invalidParam("image", "at most 16 images are allowed", "too_many_images")
			}
		default:
			data, tooLarge, err := readLimitedPart(part, MaxRequestBytes)
			if err != nil {
				if errors.Is(err, errRequestTooLarge) {
					return domain.ImageRequest{}, requestTooLarge()
				}
				return domain.ImageRequest{}, invalidBody("multipart field could not be read")
			}
			if tooLarge {
				return domain.ImageRequest{}, requestTooLarge()
			}
			raw, include, err := multipartField(name, string(data))
			if err != nil {
				return domain.ImageRequest{}, err
			}
			if include {
				fields[name] = raw
			}
		}
	}

	if endpoint == "edits" && len(images) == 0 {
		return domain.ImageRequest{}, invalidParam("image", "at least one image is required", "missing_parameter")
	}
	encoded, err := json.Marshal(images)
	if err != nil {
		return domain.ImageRequest{}, invalidBody("image list could not be encoded")
	}
	fields["image"] = encoded

	return buildRequest(ctx, fields, endpoint, defaults, reader)
}

func multipartField(name, value string) (json.RawMessage, bool, error) {
	switch name {
	case "n":
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return nil, false, nil
		}
		if _, err := strconv.ParseInt(trimmed, 10, 64); err != nil {
			return nil, false, invalidParam("n", "n must be a positive integer", "invalid_value")
		}
		return json.RawMessage(trimmed), true, nil
	case "return_base64":
		return nil, false, invalidParam(name, "return_base64 is not supported; use response_format", "unsupported_parameter")
	case "stream":
		var parsed bool
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "true", "1":
			parsed = true
		case "false", "0", "":
			parsed = false
		default:
			return nil, false, invalidParam(name, name+" must be a boolean", "invalid_value")
		}
		raw, _ := json.Marshal(parsed)
		return raw, true, nil
	case "extra_body":
		var obj map[string]json.RawMessage
		if err := json.Unmarshal([]byte(value), &obj); err != nil || obj == nil {
			return nil, false, invalidParam("extra_body", "extra_body must be valid JSON", "invalid_value")
		}
		return json.RawMessage(value), true, nil
	default:
		raw, _ := json.Marshal(value)
		return raw, true, nil
	}
}

func readLimitedPart(reader io.Reader, limit int64) ([]byte, bool, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(data)) > limit {
		return nil, true, nil
	}
	return data, false, nil
}

type boundedBody struct {
	reader    io.Reader
	remaining int64
}

func (b *boundedBody) Read(p []byte) (int, error) {
	if b.remaining <= 0 {
		var probe [1]byte
		n, err := b.reader.Read(probe[:])
		if n > 0 {
			return 0, errRequestTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, err := b.reader.Read(p)
	b.remaining -= int64(n)
	return n, err
}

func (b *boundedBody) Close() error {
	if closer, ok := b.reader.(io.Closer); ok {
		return closer.Close()
	}
	return nil
}
