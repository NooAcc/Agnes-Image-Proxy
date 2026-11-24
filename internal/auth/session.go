package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	sessionLifetime      = 30 * 24 * time.Hour
	sessionRenewWindow   = 7 * 24 * time.Hour
	sessionMaxLifetime   = 90 * 24 * time.Hour
	maxSessionTokenBytes = 4096
	sessionVersion       = 1
)

// ErrInvalidSession is returned for any token that fails verification. The
// specific reason is deliberately not exposed.
var ErrInvalidSession = errors.New("invalid session token")

// EpochStore persists the session epoch that revokes every issued token.
type EpochStore interface {
	SessionEpoch(ctx context.Context) (int64, error)
	BumpSessionEpoch(ctx context.Context) (int64, error)
}

// Claims is the verified content of a session token.
type Claims struct {
	Epoch     int64
	IssuedAt  time.Time
	ExpiresAt time.Time
}

type tokenPayload struct {
	Version   int   `json:"v"`
	Epoch     int64 `json:"e"`
	IssuedAt  int64 `json:"i"`
	ExpiresAt int64 `json:"x"`
}

// Sessions signs and verifies HMAC session tokens.
type Sessions struct {
	key    []byte
	epochs EpochStore
	now    func() time.Time
}

// NewSessions builds a signer. The key is the proxy key, so rotating it
// invalidates every existing session.
func NewSessions(key string, state EpochStore, now func() time.Time) *Sessions {
	if now == nil {
		now = time.Now
	}
	return &Sessions{key: []byte(key), epochs: state, now: now}
}

// Issue creates a token valid for 30 days from now.
func (s *Sessions) Issue(ctx context.Context) (string, error) {
	epoch, err := s.epochs.SessionEpoch(ctx)
	if err != nil {
		return "", err
	}
	now := s.now().UTC()
	return s.sign(tokenPayload{
		Version:   sessionVersion,
		Epoch:     epoch,
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(sessionLifetime).Unix(),
	}), nil
}

// Verify checks the signature before trusting any claim, then enforces expiry
// and the persisted epoch.
func (s *Sessions) Verify(ctx context.Context, token string) (*Claims, error) {
	if token == "" || len(token) > maxSessionTokenBytes {
		return nil, ErrInvalidSession
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, ErrInvalidSession
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, ErrInvalidSession
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalidSession
	}
	if !hmac.Equal(signature, s.mac(raw)) {
		return nil, ErrInvalidSession
	}

	var payload tokenPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, ErrInvalidSession
	}
	if payload.Version != sessionVersion || payload.IssuedAt <= 0 || payload.ExpiresAt <= payload.IssuedAt {
		return nil, ErrInvalidSession
	}
	now := s.now().UTC()
	if !now.Before(time.Unix(payload.ExpiresAt, 0)) {
		return nil, ErrInvalidSession
	}
	epoch, err := s.epochs.SessionEpoch(ctx)
	if err != nil {
		return nil, err
	}
	if epoch != payload.Epoch {
		return nil, ErrInvalidSession
	}
	return &Claims{
		Epoch:     payload.Epoch,
		IssuedAt:  time.Unix(payload.IssuedAt, 0).UTC(),
		ExpiresAt: time.Unix(payload.ExpiresAt, 0).UTC(),
	}, nil
}

// Renew returns a fresh token when fewer than 7 days remain, never past 90
// days from the original issue time. A nil token means no renewal is due.
func (s *Sessions) Renew(ctx context.Context, token string) (*string, error) {
	claims, err := s.Verify(ctx, token)
	if err != nil {
		return nil, err
	}
	now := s.now().UTC()
	if claims.ExpiresAt.Sub(now) >= sessionRenewWindow {
		return nil, nil
	}
	maxExpiry := claims.IssuedAt.Add(sessionMaxLifetime)
	if !now.Before(maxExpiry) {
		return nil, nil
	}
	expiry := now.Add(sessionLifetime)
	if expiry.After(maxExpiry) {
		expiry = maxExpiry
	}
	renewed := s.sign(tokenPayload{
		Version:   sessionVersion,
		Epoch:     claims.Epoch,
		IssuedAt:  claims.IssuedAt.Unix(),
		ExpiresAt: expiry.Unix(),
	})
	return &renewed, nil
}

// Revoke invalidates every issued token by bumping the persisted epoch.
func (s *Sessions) Revoke(ctx context.Context) error {
	_, err := s.epochs.BumpSessionEpoch(ctx)
	return err
}

func (s *Sessions) sign(payload tokenPayload) string {
	raw, _ := json.Marshal(payload)
	return base64.RawURLEncoding.EncodeToString(raw) + "." + base64.RawURLEncoding.EncodeToString(s.mac(raw))
}

func (s *Sessions) mac(raw []byte) []byte {
	mac := hmac.New(sha256.New, s.key)
	mac.Write(raw)
	return mac.Sum(nil)
}
