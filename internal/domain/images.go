package domain

import "encoding/json"

// PixelSize is an image dimension pair in pixels.
type PixelSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// ResolvedSize is the normalized size intent for an image request.
type ResolvedSize struct {
	Mode         string     `json:"mode"` // "tier" or "exact"
	Tier         string     `json:"tier"` // 1K..4K
	Ratio        *string    `json:"ratio"`
	DerivedRatio string     `json:"derivedRatio"`
	Expected     PixelSize  `json:"expected"`
	Exact        *PixelSize `json:"exact,omitempty"`
}

// ImageRequest is a parsed client image request.
type ImageRequest struct {
	Endpoint       string                     `json:"endpoint"`
	Model          string                     `json:"model"`
	Prompt         string                     `json:"prompt"`
	N              int64                      `json:"n"`
	Size           ResolvedSize               `json:"size"`
	ResponseFormat string                     `json:"responseFormat"`
	Images         []string                   `json:"images"`
	Warnings       []string                   `json:"warnings"`
	ExtraBody      map[string]json.RawMessage `json:"extraBody"`
}

// OutputImage is one image returned by the upstream provider.
type OutputImage struct {
	URL *string `json:"url,omitempty"`
}

// Measurement is the measured pixel size and format of an output image.
type Measurement struct {
	Size   *PixelSize `json:"size"`
	Format *string    `json:"format"`
}
