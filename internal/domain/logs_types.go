package domain

import "time"

// RequestLog is one persisted request or enrichment log entry.
type RequestLog struct {
	ID               int64             `json:"id"`
	RequestID        string            `json:"requestId"`
	TS               time.Time         `json:"ts"`
	Category         string            `json:"category"`
	Stage            string            `json:"stage"`
	Endpoint         string            `json:"endpoint"`
	Path             string            `json:"path"`
	Model            string            `json:"model"`
	Status           int               `json:"status"`
	OK               bool              `json:"ok"`
	Requested        int               `json:"requested"`
	Images           int               `json:"images"`
	Failed           int               `json:"failed"`
	DurationMS       int64             `json:"durationMs"`
	SizeRequest      *string           `json:"sizeRequest"`
	SizeActual       *string           `json:"sizeActual"`
	Attempts         []Attempt         `json:"attempts"`
	Partial          bool              `json:"partial"`
	DeliveryFailures []DeliveryFailure `json:"deliveryFailures"`
}

// UsageTotals is the shared usage shape for totals, days and models.
type UsageTotals struct {
	Requests  int64 `json:"requests"`
	Successes int64 `json:"successes"`
	Partials  int64 `json:"partials"`
	Failures  int64 `json:"failures"`
	Images    int64 `json:"images"`
}

// DailyUsage is one UTC day of usage.
type DailyUsage struct {
	Day string `json:"day"`
	UsageTotals
}

// ModelUsage is usage attributed to one model.
type ModelUsage struct {
	Model string `json:"model"`
	UsageTotals
}

// AccountHealth summarises the pool state.
type AccountHealth struct {
	Total    int `json:"total"`
	Healthy  int `json:"healthy"`
	Cooling  int `json:"cooling"`
	Disabled int `json:"disabled"`
}

// Overview is the admin dashboard payload.
type Overview struct {
	StartDay string        `json:"startDay"`
	EndDay   string        `json:"endDay"`
	Totals   UsageTotals   `json:"totals"`
	Days     []DailyUsage  `json:"days"`
	Models   []ModelUsage  `json:"models"`
	Accounts AccountHealth `json:"accounts"`
}

// CursorQuery is the shared keyset pagination query.
type CursorQuery struct {
	Before   *int64
	Limit    int
	Tag      string
	Category string
}

// Page is a keyset-paginated result.
type Page[T any] struct {
	Items      []T    `json:"items"`
	NextBefore *int64 `json:"nextBefore"`
}
