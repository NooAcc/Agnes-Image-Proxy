package service

import (
	"context"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

// Downloader fetches an original under the controlled download boundary.
type Downloader interface {
	Download(context.Context, string) ([]byte, string, error)
}

// Enricher performs thumbnail and classification work for existing rows.
type Enricher interface {
	Enrich(context.Context, []domain.GallerySource, domain.Settings) (EnrichReport, error)
}
