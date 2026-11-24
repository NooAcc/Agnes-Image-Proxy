// Package auth verifies the proxy key, signs admin sessions and rate-limits
// login attempts.
package auth

import (
	"crypto/sha256"
	"crypto/subtle"
)

// EqualSecret compares two secrets after hashing so comparison time does not
// depend on the input length or matching prefix. Empty secrets never match.
func EqualSecret(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	hashA := sha256.Sum256([]byte(a))
	hashB := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(hashA[:], hashB[:]) == 1
}
