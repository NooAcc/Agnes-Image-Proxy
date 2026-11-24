package httpapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func TestLocalReferenceBudgetStopsBeforeFurtherBodyReads(t *testing.T) {
	data := make([]byte, 20<<20)
	copy(data, testutil.PNG(t, 4, 4))
	signer := auth.NewImageLinks("secret", nil)
	spy := &publicImageSpy{data: data, stored: domain.StoredImage{MIME: "image/png", Bytes: int64(len(data))}}
	var links []string
	for _, id := range []string{"0123456789abcdef0123456789abcdef", "1123456789abcdef0123456789abcdef", "2123456789abcdef0123456789abcdef"} {
		link, _ := signer.Issue("https://images.example", id, time.Hour)
		links = append(links, link)
	}
	body, _ := json.Marshal(map[string]any{"model": "m", "prompt": "p", "size": "1K", "image": links})
	req := httptest.NewRequest("POST", "/v1/images/edits", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	_, err := images.Parse(context.Background(), req, domain.DefaultSettings(), httpapi.NewLocalReferences("https://images.example", signer, spy, nil))
	var ae *apierror.Error
	if !errors.As(err, &ae) || ae.Code == nil || *ae.Code != "image_too_large" {
		t.Fatal("budget not rejected", err)
	}
	if spy.body != 1 || spy.info != 2 {
		t.Fatalf("expanded rejected bodies: info=%d body=%d", spy.info, spy.body)
	}
}

func TestLocalReferenceAggregateBudget(t *testing.T) {
	data := make([]byte, 13<<20)
	copy(data, testutil.PNG(t, 4, 4))
	signer := auth.NewImageLinks("secret", nil)
	spy := &publicImageSpy{data: data, stored: domain.StoredImage{ID: 1, PublicID: "0123456789abcdef0123456789abcdef", MIME: "image/png", Bytes: int64(len(data))}}
	link, _ := signer.Issue("https://images.example", spy.stored.PublicID, time.Hour)
	body, _ := json.Marshal(map[string]any{"model": "m", "prompt": "p", "size": "1K", "image": []string{link, link}})
	req := httptest.NewRequest("POST", "https://images.example/v1/images/edits", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resolver := httpapi.NewLocalReferences("https://images.example", signer, spy, nil)
	_, err := images.Parse(context.Background(), req, domain.DefaultSettings(), resolver)
	var ae *apierror.Error
	if !errors.As(err, &ae) || ae.Status != 400 || ae.Code == nil || *ae.Code != "image_too_large" || spy.body != 1 {
		t.Fatalf("short URLs bypassed normalized budget: %v reads=%d", err, spy.body)
	}
}

func TestLocalReferenceSignedURLRoundTrip(t *testing.T) {
	now := time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)
	signer := auth.NewImageLinks("secret", func() time.Time { return now })
	spy := &publicImageSpy{data: testutil.PNG(t, 4, 4), stored: domain.StoredImage{ID: 1, PublicID: "0123456789abcdef0123456789abcdef", MIME: "image/png"}}
	spy.stored.Bytes = int64(len(spy.data))
	resolver := httpapi.NewLocalReferences("https://images.example", signer, spy, nil)
	link, _ := signer.Issue("https://images.example", spy.stored.PublicID, time.Hour)
	dataURI, err := resolver.ResolveReference(context.Background(), link)
	if err != nil {
		t.Fatal(err)
	}
	if dataURI != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(spy.data) {
		t.Fatal("not expanded")
	}
	size, err := resolver.Dimensions(context.Background(), dataURI)
	if err != nil || size.Width != 4 || size.Height != 4 {
		t.Fatal(size, err)
	}
	if _, err := resolver.ResolveReference(context.Background(), link); err != nil {
		t.Fatal(err)
	}
	if spy.body != 1 {
		t.Fatal("read original twice", spy.body)
	}
	now = now.Add(time.Hour)
	if _, err := resolver.ResolveReference(context.Background(), link); err == nil {
		t.Fatal("cache bypassed expiry")
	}
}
func TestLocalReferenceForeignOriginNotResolved(t *testing.T) {
	signer := auth.NewImageLinks("secret", nil)
	spy := &publicImageSpy{}
	resolver := httpapi.NewLocalReferences("https://images.example", signer, spy, nil)
	for _, origin := range []string{"https://foreign.example", "https://images.example:444"} {
		link, _ := signer.Issue(origin, "0123456789abcdef0123456789abcdef", time.Hour)
		got, err := resolver.ResolveReference(context.Background(), link)
		if err != nil || got != link {
			t.Fatal(got, err)
		}
	}
	if spy.body != 0 || spy.info != 0 {
		t.Fatal("foreign origin read local database")
	}
	link, _ := signer.Issue("https://images.example", "0123456789abcdef0123456789abcdef", time.Hour)
	parsed, _ := url.Parse(link)
	parsed.RawQuery += "&unknown=x"
	if _, err := resolver.ResolveReference(context.Background(), parsed.String()); err == nil {
		t.Fatal("unknown query accepted")
	}
	if _, err := resolver.ResolveReference(context.Background(), link+"#fragment"); err == nil {
		t.Fatal("fragment accepted")
	}
	if !strings.Contains(link, "signature=") {
		t.Fatal("fixture unsigned")
	}
}
