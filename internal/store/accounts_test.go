package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newAccountStore(t *testing.T) (*store.Store, *clock) {
	t.Helper()
	db := testutil.OpenDB(t)
	c := &clock{t: time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)}
	s, err := store.New(db, c.now, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	return s, c
}

func seedAccounts(t *testing.T, s *store.Store, n int) {
	t.Helper()
	for i := 1; i <= n; i++ {
		if _, err := s.CreateAccount(context.Background(), fmt.Sprintf("account-%d", i), fmt.Sprintf("key-%d-abcdefghij", i)); err != nil {
			t.Fatalf("create account %d: %v", i, err)
		}
	}
}

func TestCreateListGetUpdateDeleteAccounts(t *testing.T) {
	s, _ := newAccountStore(t)
	ctx := context.Background()

	created, err := s.CreateAccount(ctx, " primary ", " sk-primary-secret ")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Name != "primary" || created.Status != domain.AccountHealthy || !created.Enabled {
		t.Fatalf("unexpected summary: %+v", created)
	}

	if _, err := s.CreateAccount(ctx, "primary", "another-key-12345"); err == nil {
		t.Fatal("duplicate name accepted")
	} else {
		var apiErr *apierror.Error
		if !errors.As(err, &apiErr) || apiErr.Status != 409 {
			t.Fatalf("duplicate error = %v", err)
		}
	}

	if _, err := s.CreateAccount(ctx, "bad key", "with space"); err == nil {
		t.Fatal("key with whitespace accepted")
	}
	if _, err := s.CreateAccount(ctx, "  ", "key-abcdefghij"); err == nil {
		t.Fatal("blank name accepted")
	}

	accounts, err := s.ListAccounts(ctx)
	if err != nil || len(accounts) != 1 {
		t.Fatalf("list: %v %d", err, len(accounts))
	}

	account, err := s.GetAccount(ctx, created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if account.APIKey != "sk-primary-secret" {
		t.Fatalf("key not stored trimmed: %q", account.APIKey)
	}

	// Empty key on edit keeps the old key.
	empty := "   "
	name := "renamed"
	enabled := false
	updated, err := s.UpdateAccount(ctx, created.ID, domain.AccountPatch{Name: &name, APIKey: &empty, Enabled: &enabled})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Name != "renamed" || updated.Enabled || updated.Status != domain.AccountDisabled {
		t.Fatalf("unexpected update: %+v", updated)
	}
	if got, _ := s.GetAccount(ctx, created.ID); got.APIKey != "sk-primary-secret" {
		t.Fatalf("empty patch key changed stored key: %q", got.APIKey)
	}

	if _, err := s.UpdateAccount(ctx, 9999, domain.AccountPatch{Name: &name}); err == nil {
		t.Fatal("update of missing id accepted")
	}

	deleted, err := s.DeleteAccount(ctx, created.ID)
	if err != nil || !deleted {
		t.Fatalf("delete: %v %v", deleted, err)
	}
	if deleted, _ := s.DeleteAccount(ctx, created.ID); deleted {
		t.Fatal("second delete reported success")
	}
}

func TestClaimRoundRobinAtomic(t *testing.T) {
	s, _ := newAccountStore(t)
	seedAccounts(t, s, 3)
	ctx := context.Background()

	var order []int64
	for i := 0; i < 6; i++ {
		claimed, err := s.Claim(ctx, nil)
		if err != nil || claimed == nil {
			t.Fatalf("claim %d: %v %v", i, claimed, err)
		}
		order = append(order, claimed.ID)
	}
	want := []int64{1, 2, 3, 1, 2, 3}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("round robin = %v, want %v", order, want)
		}
	}

	// Concurrent claims must distribute evenly and keep use_seq monotonic.
	s2, _ := newAccountStore(t)
	seedAccounts(t, s2, 3)
	var mu sync.Mutex
	counts := map[int64]int{}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claimed, err := s2.Claim(ctx, nil)
			if err != nil || claimed == nil {
				t.Errorf("concurrent claim: %v %v", claimed, err)
				return
			}
			mu.Lock()
			counts[claimed.ID]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	for id, count := range counts {
		if count != 2 {
			t.Fatalf("account %d claimed %d times, want 2 (%v)", id, count, counts)
		}
	}
	if len(counts) != 3 {
		t.Fatalf("not all accounts used: %v", counts)
	}
}

func TestClaimSkipsDisabledCoolingAndExcluded(t *testing.T) {
	s, c := newAccountStore(t)
	seedAccounts(t, s, 3)
	ctx := context.Background()

	disabled := false
	if _, err := s.UpdateAccount(ctx, 2, domain.AccountPatch{Enabled: &disabled}); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if err := s.RecordFailure(ctx, 1, 10*time.Minute); err != nil {
		t.Fatalf("failure: %v", err)
	}

	claimed, err := s.Claim(ctx, nil)
	if err != nil || claimed == nil {
		t.Fatalf("claim: %v %v", claimed, err)
	}
	if claimed.ID != 3 {
		t.Fatalf("claimed %d, want healthy account 3", claimed.ID)
	}

	if claimed, err := s.Claim(ctx, []int64{3}); err != nil || claimed != nil {
		t.Fatalf("excluded-only claim = %v %v, want nil", claimed, err)
	}

	c.advance(11 * time.Minute)
	claimed, err = s.Claim(ctx, []int64{3})
	if err != nil || claimed == nil || claimed.ID != 1 {
		t.Fatalf("cooling account not reselectable after expiry: %v %v", claimed, err)
	}
}

func TestSuccessDoesNotEraseConcurrentFailure(t *testing.T) {
	s, _ := newAccountStore(t)
	seedAccounts(t, s, 1)
	ctx := context.Background()

	claimed, err := s.Claim(ctx, nil)
	if err != nil || claimed == nil {
		t.Fatalf("claim: %v %v", claimed, err)
	}
	if err := s.RecordFailure(ctx, claimed.ID, 10*time.Minute); err != nil {
		t.Fatalf("failure: %v", err)
	}
	if err := s.RecordSuccess(ctx, claimed.ID, claimed.FailCount, 2); err != nil {
		t.Fatalf("success: %v", err)
	}

	account, err := s.GetAccount(ctx, claimed.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if account.FailCount != 1 {
		t.Fatalf("failure cleared by stale success: %+v", account)
	}
	if account.CooldownUntil == nil || !account.CooldownUntil.After(time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("cooldown lost: %+v", account.CooldownUntil)
	}
	if account.UpstreamRequests != 1 || account.UpstreamImages != 2 {
		t.Fatalf("success counters not recorded: %+v", account)
	}
	if account.Status != domain.AccountCooling {
		t.Fatalf("status = %s", account.Status)
	}

	if ok, err := s.ResetHealth(ctx, claimed.ID); err != nil || !ok {
		t.Fatalf("reset health: %v %v", ok, err)
	}
	if err := s.RecordSuccess(ctx, claimed.ID, 0, 1); err != nil {
		t.Fatalf("success after reset: %v", err)
	}
	account, _ = s.GetAccount(ctx, claimed.ID)
	if account.FailCount != 0 || account.CooldownUntil != nil || account.Status != domain.AccountHealthy {
		t.Fatalf("healthy reset failed: %+v", account)
	}
}

func TestFailureNeverShortensCooldown(t *testing.T) {
	s, c := newAccountStore(t)
	seedAccounts(t, s, 1)
	ctx := context.Background()

	if err := s.RecordFailure(ctx, 1, 15*time.Minute); err != nil {
		t.Fatalf("failure: %v", err)
	}
	account, _ := s.GetAccount(ctx, 1)
	long := account.CooldownUntil

	c.advance(time.Minute)
	if err := s.RecordFailure(ctx, 1, time.Minute); err != nil {
		t.Fatalf("second failure: %v", err)
	}
	account, _ = s.GetAccount(ctx, 1)
	if !account.CooldownUntil.Equal(*long) {
		t.Fatalf("shorter cooldown shortened existing one: %v -> %v", long, account.CooldownUntil)
	}
	if account.FailCount != 2 {
		t.Fatalf("fail count = %d", account.FailCount)
	}
}

func TestMaskNeverSerializesAPIKey(t *testing.T) {
	s, _ := newAccountStore(t)
	ctx := context.Background()
	const secret = "sk-live-super-secret-value"
	if _, err := s.CreateAccount(ctx, "prod", secret); err != nil {
		t.Fatalf("create: %v", err)
	}
	accounts, err := s.ListAccounts(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	raw, err := json.Marshal(accounts)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(raw) == "" || strings.Contains(string(raw), secret) {
		t.Fatalf("full api key serialized: %s", raw)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := decoded[0]["apiKey"]; ok {
		t.Fatal("serialized account exposes apiKey field")
	}
	if decoded[0]["apiKeyMasked"] == "" || decoded[0]["apiKeyMasked"] == secret {
		t.Fatalf("bad mask: %v", decoded[0]["apiKeyMasked"])
	}
}
