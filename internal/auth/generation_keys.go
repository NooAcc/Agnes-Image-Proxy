package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"strings"
)

// GenerationKeyPrefix reserves a namespace disjoint from administrator keys.
const GenerationKeyPrefix = "sk-agnes-"

const generationKeyIDLength = 22 // 16 random bytes in raw base64url.

// GenerationKeys derives credentials from an administrator secret and private
// per-key randomness. A recipient cannot use a shared key to test guesses of
// the administrator secret offline, and the database stores no usable bearer.
type GenerationKeys struct {
	signingKey []byte
}

func NewGenerationKeys(adminKey string) GenerationKeys {
	mac := hmac.New(sha256.New, []byte(adminKey))
	mac.Write([]byte("agnes:distributed-generation-key:v1"))
	return GenerationKeys{signingKey: mac.Sum(nil)}
}

func NewGenerationKeyMaterial() (publicID, salt string) {
	var random [48]byte
	rand.Read(random[:]) // Go 1.26 guarantees success or terminates the process.
	return base64.RawURLEncoding.EncodeToString(random[:16]), base64.RawURLEncoding.EncodeToString(random[16:])
}

func (g GenerationKeys) Issue(id, salt string) string {
	mac := hmac.New(sha256.New, g.signingKey)
	mac.Write([]byte(id))
	mac.Write([]byte(salt))
	return GenerationKeyPrefix + id + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// GenerationKeyID extracts the lookup ID, without authenticating the key.
func GenerationKeyID(key string) (string, bool) {
	raw, ok := strings.CutPrefix(key, GenerationKeyPrefix)
	if !ok || len(raw) != generationKeyIDLength+base64.RawURLEncoding.EncodedLen(sha256.Size) {
		return "", false
	}
	id := raw[:generationKeyIDLength]
	if _, err := base64.RawURLEncoding.Strict().DecodeString(id); err != nil {
		return "", false
	}
	if _, err := base64.RawURLEncoding.Strict().DecodeString(raw[generationKeyIDLength:]); err != nil {
		return "", false
	}
	return id, true
}

func (g GenerationKeys) Verify(key, id, salt string) bool {
	return salt != "" && subtle.ConstantTimeCompare([]byte(key), []byte(g.Issue(id, salt))) == 1
}
