package auth_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
)

type fakeEpochs struct {
	mu    sync.Mutex
	epoch int64
	err   error
	bumps int
}

func (f *fakeEpochs) SessionEpoch(context.Context) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.epoch, f.err
}

func (f *fakeEpochs) BumpSessionEpoch(context.Context) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return 0, f.err
	}
	f.epoch++
	f.bumps++
	return f.epoch, nil
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *clock {
	return &clock{t: time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)}
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

const day = 24 * time.Hour

func newTestSessions(t *testing.T) (*auth.Sessions, *fakeEpochs, *clock) {
	t.Helper()
	epochs := &fakeEpochs{epoch: 1}
	clk := newClock()
	return auth.NewSessions("master-key", epochs, clk.Now), epochs, clk
}

func TestSessionIssueVerify(t *testing.T) {
	sessions, _, clk := newTestSessions(t)
	ctx := context.Background()
	token, err := sessions.Issue(ctx)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	claims, err := sessions.Verify(ctx, token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims.Epoch != 1 {
		t.Fatalf("epoch = %d", claims.Epoch)
	}
	if !claims.IssuedAt.Equal(clk.Now()) || claims.ExpiresAt.Sub(claims.IssuedAt) != 30*day {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestSessionRejectsTamperedAndOversized(t *testing.T) {
	sessions, _, _ := newTestSessions(t)
	ctx := context.Background()
	token, err := sessions.Issue(ctx)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		t.Fatalf("token shape = %q", token)
	}
	tampered := []string{
		"x" + token,
		parts[0] + "." + parts[1][:len(parts[1])-2] + "AA",
		parts[0] + ".x" + parts[1],
		parts[0],
		"",
		strings.Repeat("a", 8192),
	}
	for _, candidate := range tampered {
		if _, err := sessions.Verify(ctx, candidate); err == nil {
			t.Fatalf("candidate accepted: %q", candidate[:min(len(candidate), 32)])
		}
	}
}

func TestSessionExpiry(t *testing.T) {
	sessions, _, clk := newTestSessions(t)
	ctx := context.Background()
	token, _ := sessions.Issue(ctx)
	clk.Advance(30*day - time.Second)
	if _, err := sessions.Verify(ctx, token); err != nil {
		t.Fatalf("valid before expiry: %v", err)
	}
	clk.Advance(2 * time.Second)
	if _, err := sessions.Verify(ctx, token); err == nil {
		t.Fatal("expired token accepted")
	}
}

func TestSessionRenewalWindow(t *testing.T) {
	sessions, _, clk := newTestSessions(t)
	ctx := context.Background()
	token, _ := sessions.Issue(ctx)
	issuedAt := clk.Now()

	clk.Advance(10 * day) // 20 days remaining: no renewal
	renewed, err := sessions.Renew(ctx, token)
	if err != nil || renewed != nil {
		t.Fatalf("early renew = %v %v", renewed, err)
	}

	clk.Advance(14 * day) // 6 days remaining: renew
	renewed, err = sessions.Renew(ctx, token)
	if err != nil || renewed == nil {
		t.Fatalf("renew: %v %v", renewed, err)
	}
	claims, err := sessions.Verify(ctx, *renewed)
	if err != nil {
		t.Fatalf("verify renewed: %v", err)
	}
	if !claims.IssuedAt.Equal(issuedAt) {
		t.Fatalf("issuedAt moved: %+v", claims)
	}
	if !claims.ExpiresAt.Equal(clk.Now().Add(30 * day)) {
		t.Fatalf("renewed expiry = %v", claims.ExpiresAt)
	}
}

func TestSessionMaxLifetime(t *testing.T) {
	sessions, _, clk := newTestSessions(t)
	ctx := context.Background()
	token, _ := sessions.Issue(ctx)
	issuedAt := clk.Now()

	// Walk renewals until the sliding window would pass the 90 day cap.
	clk.Advance(24 * day)
	token = mustRenew(t, sessions, ctx, token)
	clk.Advance(29 * day) // day 53, remaining 1 day
	token = mustRenew(t, sessions, ctx, token)
	clk.Advance(29 * day) // day 82, remaining 1 day
	token = mustRenew(t, sessions, ctx, token)

	claims, err := sessions.Verify(ctx, token)
	if err != nil {
		t.Fatalf("verify capped token: %v", err)
	}
	if !claims.ExpiresAt.Equal(issuedAt.Add(90 * day)) {
		t.Fatalf("expiry not capped: %v", claims.ExpiresAt)
	}

	clk.Advance(6 * day) // day 88, remaining 2 days
	renewed, err := sessions.Renew(ctx, token)
	if err != nil || renewed == nil {
		t.Fatalf("renew near cap: %v %v", renewed, err)
	}
	capped, err := sessions.Verify(ctx, *renewed)
	if err != nil || !capped.ExpiresAt.Equal(issuedAt.Add(90*day)) {
		t.Fatalf("renewal extended past cap: %+v %v", capped, err)
	}

	clk.Advance(2 * day) // issued+90d reached: token expires, no extension
	if renewed2, err := sessions.Renew(ctx, token); err == nil || renewed2 != nil {
		t.Fatalf("renew at max lifetime = %v %v", renewed2, err)
	}
}

func mustRenew(t *testing.T, sessions *auth.Sessions, ctx context.Context, token string) string {
	t.Helper()
	renewed, err := sessions.Renew(ctx, token)
	if err != nil || renewed == nil {
		t.Fatalf("renew: %v %v", renewed, err)
	}
	return *renewed
}

func TestSessionEpochAndKeyRotation(t *testing.T) {
	sessions, epochs, _ := newTestSessions(t)
	ctx := context.Background()
	token, _ := sessions.Issue(ctx)

	epochs.mu.Lock()
	epochs.epoch = 2
	epochs.mu.Unlock()
	if _, err := sessions.Verify(ctx, token); err == nil {
		t.Fatal("token valid after epoch change")
	}

	rotated := auth.NewSessions("new-master-key", epochs, newClock().Now)
	other, err := rotated.Issue(ctx)
	if err != nil {
		t.Fatalf("issue rotated: %v", err)
	}
	if _, err := sessions.Verify(ctx, other); err == nil {
		t.Fatal("token valid under the wrong key")
	}
	if _, err := rotated.Verify(ctx, other); err != nil {
		t.Fatalf("rotated session invalid: %v", err)
	}
}

func TestSessionRevokeBumpsEpoch(t *testing.T) {
	sessions, epochs, _ := newTestSessions(t)
	ctx := context.Background()
	token, _ := sessions.Issue(ctx)
	if err := sessions.Revoke(ctx); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if epochs.bumps != 1 {
		t.Fatalf("bumps = %d", epochs.bumps)
	}
	if _, err := sessions.Verify(ctx, token); err == nil {
		t.Fatal("revoked token accepted")
	}
}

func TestSecretEqual(t *testing.T) {
	if !auth.EqualSecret("secret", "secret") {
		t.Fatal("equal secrets rejected")
	}
	if auth.EqualSecret("secret", "secreT") || auth.EqualSecret("secret", "") || auth.EqualSecret("", "") {
		t.Fatal("distinct secrets accepted")
	}
}

func TestLimiterLockout(t *testing.T) {
	clk := newClock()
	limiter := auth.NewLimiter(clk.Now)
	for i := 0; i < 10; i++ {
		if !limiter.Allow() {
			t.Fatalf("attempt %d blocked too early", i+1)
		}
		limiter.Failed()
	}
	if limiter.Allow() {
		t.Fatal("11th attempt allowed after 10 failures")
	}
	clk.Advance(59 * time.Second)
	if limiter.Allow() {
		t.Fatal("lockout expired early")
	}
	clk.Advance(2 * time.Second)
	if !limiter.Allow() {
		t.Fatal("lockout did not expire")
	}
	limiter.Failed()
	if !limiter.Allow() {
		t.Fatal("failure count not reset after lockout")
	}
	for i := 0; i < 9; i++ {
		limiter.Failed()
	}
	limiter.Reset()
	if !limiter.Allow() {
		t.Fatal("reset did not clear failures")
	}
}
