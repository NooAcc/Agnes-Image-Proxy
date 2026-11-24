package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

var ErrInvalidImageLink = errors.New("invalid image link")

type ImageLinkClaims struct {
	PublicID  string
	ExpiresAt time.Time
}
type ImageLinks struct {
	key []byte
	now func() time.Time
}

func NewImageLinks(apiKey string, now func() time.Time) *ImageLinks {
	if now == nil {
		now = time.Now
	}
	return &ImageLinks{key: []byte(apiKey), now: now}
}
func validPublicID(id string) bool {
	if len(id) != 32 || strings.ToLower(id) != id {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}
func (s *ImageLinks) signature(id, expiry string) []byte {
	mac := hmac.New(sha256.New, s.key)
	_, _ = mac.Write([]byte("agnes:image-content:v1\n" + id + "\n" + expiry))
	return mac.Sum(nil)
}
func (s *ImageLinks) Issue(baseURL, publicID string, ttl time.Duration) (string, error) {
	if s == nil || len(s.key) == 0 || !validPublicID(publicID) || ttl < time.Hour || ttl > 720*time.Hour || ttl%time.Hour != 0 {
		return "", ErrInvalidImageLink
	}
	origin, err := domain.NormalizeImageOrigin(baseURL)
	if err != nil || origin == "" {
		return "", ErrInvalidImageLink
	}
	expires := strconv.FormatInt(s.now().Add(ttl).Unix(), 10)
	query := url.Values{"expires": {expires}, "signature": {base64.RawURLEncoding.EncodeToString(s.signature(publicID, expires))}}
	return origin + "/v1/images/content/" + publicID + "?" + query.Encode(), nil
}
func (s *ImageLinks) Verify(publicID string, query url.Values) (ImageLinkClaims, error) {
	invalid := func() (ImageLinkClaims, error) { return ImageLinkClaims{}, ErrInvalidImageLink }
	if s == nil || len(s.key) == 0 || !validPublicID(publicID) || len(query) != 2 || len(query["expires"]) != 1 || len(query["signature"]) != 1 {
		return invalid()
	}
	raw := query.Get("expires")
	expires, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || expires <= 0 || strconv.FormatInt(expires, 10) != raw || s.now().Unix() >= expires {
		return invalid()
	}
	encoded := query.Get("signature")
	signature, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(signature) != sha256.Size || base64.RawURLEncoding.EncodeToString(signature) != encoded || !hmac.Equal(signature, s.signature(publicID, raw)) {
		return invalid()
	}
	return ImageLinkClaims{PublicID: publicID, ExpiresAt: time.Unix(expires, 0).UTC()}, nil
}
