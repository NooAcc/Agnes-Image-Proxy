package domain

import "time"

// NSFWScores carries the five-class classifier output.
type NSFWScores struct {
	Drawing float64 `json:"drawing"`
	Hentai  float64 `json:"hentai"`
	Safe    float64 `json:"safe"`
	Porn    float64 `json:"porn"`
	Sexy    float64 `json:"sexy"`
	IsNSFW  bool    `json:"isNsfw"`
}

// GalleryItem is the list view of a generated image without blobs.
type GalleryItem struct {
	ID           int64       `json:"id"`
	CreatedAt    time.Time   `json:"createdAt"`
	RequestID    string      `json:"requestId"`
	Model        string      `json:"model"`
	Prompt       string      `json:"prompt"`
	Size         string      `json:"size"`
	AccountName  string      `json:"accountName"`
	Tag          string      `json:"nsfwTag"`
	NSFWScores   *NSFWScores `json:"nsfwScores"`
	EnrichStatus string      `json:"enrichStatus"`
	Archived     bool        `json:"archived"`
	SourceURL    *string     `json:"sourceUrl"`
}

// GallerySource is the enrichment view of one gallery row.
type GallerySource struct {
	ID          int64   `json:"id"`
	SourceURL   *string `json:"sourceUrl"`
	MIME        string  `json:"mime"`
	Bytes       int64   `json:"bytes"`
	SourceBytes int64   `json:"sourceBytes"`
	HasImage    bool    `json:"hasImage"`
	// Data is the local original image bytes when the caller has them; it is
	// never serialized and is used for the base64 enrichment fallback.
	Data []byte `json:"-"`
}

// GalleryInsert is a new archived image row.
type GalleryInsert struct {
	RequestID   string
	Model       string
	Prompt      string
	SizeRequest string
	SizeActual  *string
	AccountID   *int64
	AccountName string
	SourceURL   *string
	SourceMIME  *string
	SourceBytes *int64
	Image       []byte
	ImageMIME   *string
}

// EnrichmentWrite updates thumbnail and NSFW state.
type EnrichmentWrite struct {
	Thumb     []byte
	ThumbMIME string
	Status    string
	Tag       string
	Scores    *NSFWScores
	Error     *string
	At        time.Time
}
