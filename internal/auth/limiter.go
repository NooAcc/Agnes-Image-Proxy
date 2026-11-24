package auth

import (
	"sync"
	"time"
)

const (
	loginFailureLimit  = 10
	loginLockoutWindow = 60 * time.Second
)

// Limiter blocks logins after repeated failures for a fixed window.
type Limiter struct {
	mu          sync.Mutex
	now         func() time.Time
	failures    int
	lockedUntil time.Time
}

// NewLimiter builds a limiter using the supplied clock.
func NewLimiter(now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{now: now}
}

// Allow reports whether a login attempt may proceed.
func (l *Limiter) Allow() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Before(l.lockedUntil) {
		return false
	}
	if !l.lockedUntil.IsZero() {
		l.failures = 0
		l.lockedUntil = time.Time{}
	}
	return true
}

// Failed records one rejected attempt.
func (l *Limiter) Failed() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Before(l.lockedUntil) {
		return
	}
	l.failures++
	if l.failures >= loginFailureLimit {
		l.lockedUntil = now.Add(loginLockoutWindow)
	}
}

// Reset clears failures after a successful login.
func (l *Limiter) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures = 0
	l.lockedUntil = time.Time{}
}
