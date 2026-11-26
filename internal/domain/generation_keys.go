package domain

import "time"

// GenerationKey is the stored record. PublicID isn't itself a credential.
type GenerationKey struct {
	ID        int64     `json:"id"`
	PublicID  string    `json:"-"`
	Salt      string    `json:"-"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}
