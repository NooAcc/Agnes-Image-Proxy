package auth_test

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
)

const publicImageID = "0123456789abcdef0123456789abcdef"

func TestImageLinksExpiryAndTampering(t *testing.T) {
	now := time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)
	signer := auth.NewImageLinks("secret", func() time.Time { return now })
	link, err := signer.Issue("https://images.example.com", publicImageID, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if parsed.Path != "/v1/images/content/"+publicImageID || query.Get("expires") != "1795564800" || len(query) != 2 {
		t.Fatalf("link: %s", link)
	}
	claims, err := signer.Verify(publicImageID, query)
	if err != nil || claims.PublicID != publicImageID || !claims.ExpiresAt.Equal(now.Add(24*time.Hour)) {
		t.Fatalf("claims: %+v %v", claims, err)
	}
	expiry := now.Add(24 * time.Hour)
	now = expiry.Add(-time.Second)
	if _, err := signer.Verify(publicImageID, query); err != nil {
		t.Fatal(err)
	}
	now = expiry
	if _, err := signer.Verify(publicImageID, query); !errors.Is(err, auth.ErrInvalidImageLink) {
		t.Fatal("expiry accepted")
	}
	now = expiry.Add(-time.Hour)
	for _, mutate := range []func(url.Values){
		func(q url.Values) { q.Set("expires", strconv.FormatInt(expiry.Unix()+1, 10)) },
		func(q url.Values) { q.Set("signature", strings.Repeat("a", 43)) },
		func(q url.Values) { q.Add("expires", q.Get("expires")) }, func(q url.Values) { q.Set("unknown", "x") },
		func(q url.Values) { q.Set("expires", "0"+q.Get("expires")) }, func(q url.Values) { q.Set("expires", "+"+q.Get("expires")) },
		func(q url.Values) { q.Set("expires", "9223372036854775808") }, func(q url.Values) { q.Set("signature", q.Get("signature")+"=") },
	} {
		q := url.Values{}
		for k, v := range query {
			q[k] = append([]string(nil), v...)
		}
		mutate(q)
		if _, err := signer.Verify(publicImageID, q); !errors.Is(err, auth.ErrInvalidImageLink) {
			t.Fatalf("tamper accepted: %v %v", q, err)
		}
	}
	if _, err := signer.Verify("1123456789abcdef0123456789abcdef", query); err == nil {
		t.Fatal("wrong ID accepted")
	}
	if _, err := auth.NewImageLinks("other", func() time.Time { return now }).Verify(publicImageID, query); err == nil {
		t.Fatal("wrong key accepted")
	}
}
func TestImageLinksTTLUpdateAndRotation(t *testing.T) {
	now := time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)
	signer := auth.NewImageLinks("secret", func() time.Time { return now })
	old, _ := signer.Issue("https://images.example.com", publicImageID, 24*time.Hour)
	next, _ := signer.Issue("https://images.example.com", publicImageID, time.Hour)
	oldURL, _ := url.Parse(old)
	nextURL, _ := url.Parse(next)
	if nextURL.Query().Get("expires") != "1795482000" {
		t.Fatal(next)
	}
	now = now.Add(2 * time.Hour)
	if _, err := signer.Verify(publicImageID, oldURL.Query()); err != nil {
		t.Fatal("TTL change expired old link", err)
	}
	if _, err := signer.Verify(publicImageID, nextURL.Query()); err == nil {
		t.Fatal("new short TTL ineffective")
	}
	if _, err := auth.NewImageLinks("rotated", func() time.Time { return now }).Verify(publicImageID, oldURL.Query()); err == nil {
		t.Fatal("rotation ineffective")
	}
	for _, ttl := range []time.Duration{0, 30 * time.Minute, 721 * time.Hour} {
		if _, err := signer.Issue("https://images.example.com", publicImageID, ttl); err == nil {
			t.Fatal("invalid TTL accepted")
		}
	}
	for _, id := range []string{"1", strings.ToUpper(publicImageID), strings.Repeat("z", 32)} {
		if _, err := signer.Issue("https://images.example.com", id, time.Hour); err == nil {
			t.Fatal("invalid ID accepted")
		}
	}
}
