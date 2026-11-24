package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

var nsfwTagOrder = []string{"safe", "drawing", "sexy", "porn", "hentai"}

// TagForNSFW validates the classifier scores and returns the winning tag.
// Ties resolve in safe/drawing/sexy/porn/hentai order.
func TagForNSFW(scores domain.NSFWScores) (string, error) {
	values := map[string]float64{
		"safe": scores.Safe, "drawing": scores.Drawing, "sexy": scores.Sexy,
		"porn": scores.Porn, "hentai": scores.Hentai,
	}
	for _, tag := range nsfwTagOrder {
		value := values[tag]
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1 {
			return "", fmt.Errorf("nsfw score for %s is invalid", tag)
		}
	}
	best := nsfwTagOrder[0]
	for _, tag := range nsfwTagOrder[1:] {
		if values[tag] > values[best] {
			best = tag
		}
	}
	return best, nil
}

type enrichOutcome struct {
	success   bool
	scores    domain.NSFWScores
	thumb     []byte
	thumbMIME string
	err       string
	retryable bool
}

type enrichData struct {
	Base64      string          `json:"base64"`
	ContentType string          `json:"contentType"`
	NSFW        json.RawMessage `json:"nsfw"`
}

// Enrich requests thumbnails and NSFW classification, then persists each
// outcome through the configured writer.
func (e *Edge) Enrich(ctx context.Context, sources []domain.GallerySource, settings domain.Settings) (EnrichReport, error) {
	report := EnrichReport{}
	if settings.ImageServiceBaseURL == "" || len(sources) == 0 {
		return report, nil
	}
	report.Processed = len(sources)

	params := map[string]any{
		"width":   settings.ThumbnailWidth,
		"height":  settings.ThumbnailWidth,
		"crop":    "none",
		"size":    "down",
		"format":  "webp",
		"quality": settings.ThumbnailQuality,
		"nsfw":    1,
	}
	timeout := timeDurationMS(settings.EnrichTimeoutMS)
	outcomes := make(map[int64]enrichOutcome, len(sources))
	eligible := make([]domain.GallerySource, 0, len(sources))

	for _, source := range sources {
		if sourceHasURL(source) {
			eligible = append(eligible, source)
			continue
		}
		switch {
		case !source.HasImage || len(source.Data) == 0:
			outcomes[source.ID] = enrichOutcome{err: "no image source"}
		case int64(len(source.Data)) > maxEnrichSourceBytes:
			outcomes[source.ID] = enrichOutcome{err: "source exceeds 50 MiB"}
		case int64(len(source.Data)) > enrichBatchSourceBytes:
			outcomes[source.ID] = enrichOutcome{err: "source exceeds batch budget"}
		default:
			eligible = append(eligible, source)
		}
	}

	request := func(chunk []domain.GallerySource, inline bool) {
		items := make([]batchItem, 0, len(chunk))
		for _, source := range chunk {
			item := batchItem{UUID: strconv.FormatInt(source.ID, 10), Params: params}
			if !inline && sourceHasURL(source) {
				item.URL = *source.SourceURL
			} else {
				item.Base64 = base64.StdEncoding.EncodeToString(source.Data)
				item.ContentType = sourceMIME(source)
			}
			items = append(items, item)
		}
		results, err := e.postBatch(ctx, settings.ImageServiceBaseURL, timeout, items)
		if err != nil {
			for _, source := range chunk {
				outcomes[source.ID] = enrichOutcome{err: err.Error()}
			}
			return
		}
		for _, source := range chunk {
			outcomes[source.ID] = outcomeFor(source, results[strconv.FormatInt(source.ID, 10)])
		}
	}

	for _, chunk := range chunkEnrichSources(eligible, false) {
		request(chunk, false)
	}

	retry := make([]domain.GallerySource, 0)
	for _, source := range eligible {
		outcome := outcomes[source.ID]
		if !outcome.retryable || !sourceHasURL(source) || len(source.Data) == 0 {
			continue
		}
		if int64(len(source.Data)) > maxEnrichSourceBytes {
			continue
		}
		if int64(len(source.Data)) > enrichBatchSourceBytes {
			outcomes[source.ID] = enrichOutcome{err: "source exceeds batch budget"}
			continue
		}
		retry = append(retry, source)
	}
	for _, chunk := range chunkEnrichSources(retry, true) {
		request(chunk, true)
	}

	at := e.now().UTC()
	for _, source := range sources {
		outcome, ok := outcomes[source.ID]
		if !ok {
			continue
		}
		if outcome.success {
			tag, err := TagForNSFW(outcome.scores)
			if err != nil {
				writeFailure(ctx, e.writer, source.ID, "nsfw: prediction unavailable", at, &report)
				continue
			}
			write := domain.EnrichmentWrite{
				Thumb:     outcome.thumb,
				ThumbMIME: outcome.thumbMIME,
				Status:    "success",
				Tag:       tag,
				Scores:    &outcome.scores,
				At:        at,
			}
			if e.writer != nil {
				if err := e.writer.SetEnrichment(ctx, source.ID, write); err != nil {
					report.Failed++
					continue
				}
			}
			report.Succeeded++
			continue
		}
		writeFailure(ctx, e.writer, source.ID, outcome.err, at, &report)
	}
	return report, nil
}

func outcomeFor(source domain.GallerySource, entry batchResult) enrichOutcome {
	if !entry.ok() {
		message := entry.Error
		if message == "" {
			message = "image service item failed"
		}
		return enrichOutcome{err: message, retryable: true}
	}
	if len(entry.Data) == 0 {
		return enrichOutcome{err: "nsfw: prediction unavailable"}
	}
	var data *enrichData
	if err := json.Unmarshal(entry.Data, &data); err != nil || data == nil {
		return enrichOutcome{err: "nsfw: prediction unavailable"}
	}
	scores, err := parseNSFWScores(data.NSFW)
	if err != nil {
		return enrichOutcome{err: "nsfw: prediction unavailable"}
	}
	thumb, thumbMIME := decodeThumbnail(data, source)
	return enrichOutcome{success: true, scores: *scores, thumb: thumb, thumbMIME: thumbMIME}
}

func parseNSFWScores(raw json.RawMessage) (*domain.NSFWScores, error) {
	var fields map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, fmt.Errorf("missing nsfw data")
	}
	read := func(name string) (float64, error) {
		value, ok := fields[name]
		if !ok {
			return 0, fmt.Errorf("missing %s", name)
		}
		var number float64
		if err := json.Unmarshal(value, &number); err != nil {
			return 0, err
		}
		if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > 1 {
			return 0, fmt.Errorf("invalid %s", name)
		}
		return number, nil
	}
	scores := &domain.NSFWScores{}
	var err error
	if scores.Drawing, err = read("drawing"); err != nil {
		return nil, err
	}
	if scores.Hentai, err = read("hentai"); err != nil {
		return nil, err
	}
	if scores.Safe, err = read("safe"); err != nil {
		return nil, err
	}
	if scores.Porn, err = read("porn"); err != nil {
		return nil, err
	}
	if scores.Sexy, err = read("sexy"); err != nil {
		return nil, err
	}
	isNsfw, ok := fields["isNsfw"]
	if !ok || json.Unmarshal(isNsfw, &scores.IsNSFW) != nil {
		return nil, fmt.Errorf("missing isNsfw")
	}
	return scores, nil
}

func decodeThumbnail(data *enrichData, source domain.GallerySource) ([]byte, string) {
	if data.Base64 == "" {
		return nil, ""
	}
	decoded, err := base64.StdEncoding.DecodeString(data.Base64)
	if err != nil {
		return nil, ""
	}
	mime := images.SniffImage(decoded)
	if mime == "" {
		return nil, ""
	}
	if source.Bytes > 0 && int64(len(decoded)) >= source.Bytes {
		return nil, ""
	}
	return decoded, mime
}

func chunkEnrichSources(sources []domain.GallerySource, inline bool) [][]domain.GallerySource {
	var chunks [][]domain.GallerySource
	chunk := make([]domain.GallerySource, 0, edgeBatchItems)
	sum := 0
	flush := func() {
		if len(chunk) > 0 {
			chunks = append(chunks, chunk)
			chunk = make([]domain.GallerySource, 0, edgeBatchItems)
			sum = 0
		}
	}
	for _, source := range sources {
		cost := 0
		if inline {
			cost = len(source.Data)
		}
		if len(chunk) > 0 && (len(chunk) >= edgeBatchItems || sum+cost > enrichBatchSourceBytes) {
			flush()
		}
		chunk = append(chunk, source)
		sum += cost
	}
	flush()
	return chunks
}

func writeFailure(ctx context.Context, writer EnrichmentWriter, id int64, message string, at time.Time, report *EnrichReport) {
	truncated := truncateError(message)
	if writer != nil {
		if err := writer.SetEnrichment(ctx, id, domain.EnrichmentWrite{Status: "failed", Error: &truncated, At: at}); err != nil {
			report.Failed++
			return
		}
	}
	report.Failed++
}

func sourceMIME(source domain.GallerySource) string {
	if source.MIME != "" {
		return source.MIME
	}
	if mime := images.SniffImage(source.Data); mime != "" {
		return mime
	}
	return "application/octet-stream"
}
