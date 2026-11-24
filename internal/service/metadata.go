package service

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// Measure resolves real output dimensions through Edge-Images metadata. It is
// best-effort: failed items stay nil and a single warning is returned.
func (e *Edge) Measure(ctx context.Context, outputs []domain.OutputImage, settings domain.Settings) ([]domain.Measurement, []string) {
	measurements := make([]domain.Measurement, len(outputs))
	if settings.ImageServiceBaseURL == "" || len(outputs) == 0 {
		return measurements, nil
	}

	var failed bool
	for start := 0; start < len(outputs); start += edgeBatchItems {
		end := start + edgeBatchItems
		if end > len(outputs) {
			end = len(outputs)
		}
		chunk := outputs[start:end]
		items := make([]batchItem, 0, len(chunk))
		for index, output := range chunk {
			uuid := strconv.Itoa(start + index)
			item := batchItem{UUID: uuid, Params: map[string]any{"format": "json"}}
			if output.URL != nil && *output.URL != "" {
				item.URL = *output.URL
			} else if output.Base64 != nil && *output.Base64 != "" {
				item.Base64 = *output.Base64
			}
			items = append(items, item)
		}

		results, err := e.postBatch(ctx, settings.ImageServiceBaseURL, measureTimeout, items)
		if err != nil {
			failed = true
			continue
		}
		for index := range chunk {
			uuid := strconv.Itoa(start + index)
			entry, ok := results[uuid]
			if !ok || !entry.ok() || len(entry.Data) == 0 {
				failed = true
				continue
			}
			var data struct {
				Width             int    `json:"width"`
				Height            int    `json:"height"`
				Format            string `json:"format"`
				SourceContentType string `json:"sourceContentType"`
			}
			if err := json.Unmarshal(entry.Data, &data); err != nil || data.Width < 1 || data.Height < 1 {
				failed = true
				continue
			}
			size := domain.PixelSize{Width: data.Width, Height: data.Height}
			format := normalizeMetadataFormat(data.Format)
			if format == nil {
				format = formatFromContentType(data.SourceContentType)
			}
			measurements[start+index] = domain.Measurement{Size: &size, Format: format}
		}
	}

	if failed {
		return measurements, []string{"size-measure-failed"}
	}
	return measurements, nil
}

func normalizeMetadataFormat(value string) *string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "jpg", "jpeg":
		normalized = "jpeg"
	case "png", "webp":
	default:
		return nil
	}
	return &normalized
}

func formatFromContentType(value string) *string {
	value = strings.TrimSpace(value)
	slash := strings.IndexByte(value, '/')
	if slash < 0 {
		return nil
	}
	return normalizeMetadataFormat(value[slash+1:])
}
