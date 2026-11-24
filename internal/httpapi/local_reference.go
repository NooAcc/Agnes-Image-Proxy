package httpapi

import (
	"context"
	"encoding/base64"
	"net/url"
	"strings"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

type LocalReferenceStore interface {
	PublicImageInfo(context.Context, string) (domain.StoredImage, error)
	PublicImageContent(context.Context, string) ([]byte, string, error)
}
type LocalReferences struct {
	baseURL  string
	signer   *auth.ImageLinks
	store    LocalReferenceStore
	fallback images.ReferenceReader
	cache    map[string]string
	sizes    map[string]domain.PixelSize
}

func NewLocalReferences(baseURL string, signer *auth.ImageLinks, store LocalReferenceStore, fallback images.ReferenceReader) *LocalReferences {
	origin, _ := domain.NormalizeImageOrigin(baseURL)
	return &LocalReferences{baseURL: origin, signer: signer, store: store, fallback: fallback, cache: map[string]string{}, sizes: map[string]domain.PixelSize{}}
}
func invalidLocalReference() error {
	return apierror.Invalid("image", "reference image is unavailable", "reference_image_unsupported")
}
func (r *LocalReferences) ResolveReference(ctx context.Context, source string) (string, error) {
	return r.ResolveReferenceWithinBudget(ctx, source, images.MaxRequestBytes)
}
func referenceBudgetExceeded() error {
	return apierror.Invalid("image", "normalized reference images are too large", "image_too_large")
}
func (r *LocalReferences) ResolveReferenceWithinBudget(ctx context.Context, source string, budget int) (string, error) {
	parsed, err := url.Parse(source)
	if err != nil {
		return "", invalidLocalReference()
	}
	origin, _ := domain.NormalizeImageOrigin(parsed.Scheme + "://" + parsed.Host)
	if origin != r.baseURL || r.baseURL == "" || !strings.HasPrefix(parsed.Path, "/v1/images/content/") {
		return source, nil
	}
	if parsed.User != nil || parsed.Fragment != "" || strings.Contains(source, "#") || parsed.RawPath != "" {
		return "", invalidLocalReference()
	}
	id := strings.TrimPrefix(parsed.Path, "/v1/images/content/")
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil || strings.Contains(id, "/") || r.signer == nil {
		return "", invalidLocalReference()
	}
	if _, err := r.signer.Verify(id, query); err != nil {
		return "", invalidLocalReference()
	}
	if cached, ok := r.cache[source]; ok {
		if len(cached)+2 > budget {
			return "", referenceBudgetExceeded()
		}
		return cached, nil
	}
	if r.store == nil {
		return "", invalidLocalReference()
	}
	info, err := r.store.PublicImageInfo(ctx, id)
	if err != nil || info.Bytes <= 0 || info.Bytes > images.MaxInputImageBytes {
		return "", invalidLocalReference()
	}
	if base64.StdEncoding.EncodedLen(int(info.Bytes))+len("data:"+info.MIME+";base64,")+2 > budget {
		return "", referenceBudgetExceeded()
	}
	data, mime, err := r.store.PublicImageContent(ctx, id)
	if err != nil || len(data) == 0 || len(data) > images.MaxInputImageBytes || images.SniffImage(data) != mime {
		return "", invalidLocalReference()
	}
	if base64.StdEncoding.EncodedLen(len(data))+len("data:"+mime+";base64,")+2 > budget {
		return "", referenceBudgetExceeded()
	}
	value := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
	if size, err := images.ImageDimensions(data); err == nil {
		r.sizes[value] = size
	}
	r.cache[source] = value
	return value, nil
}
func (r *LocalReferences) Dimensions(ctx context.Context, source string) (domain.PixelSize, error) {
	normalized, err := r.ResolveReference(ctx, source)
	if err != nil {
		return domain.PixelSize{}, err
	}
	if size, ok := r.sizes[normalized]; ok {
		return size, nil
	}
	if r.fallback != nil {
		return r.fallback.Dimensions(ctx, normalized)
	}
	if strings.HasPrefix(normalized, "data:") {
		_, data, err := images.DecodeImageDataURI(normalized, images.MaxInputImageBytes)
		if err != nil {
			return domain.PixelSize{}, invalidLocalReference()
		}
		return images.ImageDimensions(data)
	}
	return domain.PixelSize{}, invalidLocalReference()
}
