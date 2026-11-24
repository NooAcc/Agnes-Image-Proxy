package domain

import (
	"strings"
	"time"
)

// Account status values reported to the admin console. They are derived from
// enabled + cooldown state at read time.
const (
	AccountHealthy  = "healthy"
	AccountCooling  = "cooling"
	AccountDisabled = "disabled"
)

// Account is the internal account representation. The upstream key must never
// be serialized.
type Account struct {
	ID               int64      `json:"id"`
	Name             string     `json:"name"`
	APIKey           string     `json:"-"`
	Enabled          bool       `json:"enabled"`
	Status           string     `json:"status"`
	CooldownUntil    *time.Time `json:"cooldownUntil"`
	FailCount        int64      `json:"failCount"`
	LastUsedAt       *time.Time `json:"lastUsedAt"`
	UpstreamRequests int64      `json:"upstreamRequests"`
	UpstreamImages   int64      `json:"upstreamImages"`
	CreatedAt        time.Time  `json:"createdAt"`
}

// ClaimedAccount is the minimal credential set handed to a generation attempt.
type ClaimedAccount struct {
	ID        int64
	Name      string
	APIKey    string
	FailCount int64
}

// AccountSummary is the admin-facing account view. It carries only a masked
// key and never embeds Account.
type AccountSummary struct {
	ID               int64      `json:"id"`
	Name             string     `json:"name"`
	APIKeyMasked     string     `json:"apiKeyMasked"`
	Enabled          bool       `json:"enabled"`
	Status           string     `json:"status"`
	CooldownUntil    *time.Time `json:"cooldownUntil"`
	FailCount        int64      `json:"failCount"`
	LastUsedAt       *time.Time `json:"lastUsedAt"`
	UpstreamRequests int64      `json:"upstreamRequests"`
	UpstreamImages   int64      `json:"upstreamImages"`
	CreatedAt        time.Time  `json:"createdAt"`
}

// AccountPatch is a partial account update. Empty APIKey means "keep".
type AccountPatch struct {
	Name    *string `json:"name"`
	APIKey  *string `json:"apiKey"`
	Enabled *bool   `json:"enabled"`
}

// MaskAPIKey returns a display-safe form of an upstream key.
func MaskAPIKey(key string) string {
	key = strings.TrimSpace(key)
	if len(key) < 12 {
		return "****"
	}
	return key[:4] + "…" + key[len(key)-4:]
}

// AccountStatusFor derives the reported status at time now.
func AccountStatusFor(enabled bool, cooldown *time.Time, now time.Time) string {
	if !enabled {
		return AccountDisabled
	}
	if cooldown != nil && cooldown.After(now) {
		return AccountCooling
	}
	return AccountHealthy
}
