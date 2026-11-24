package images_test

import (
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

func ptr[T any](v T) *T { return &v }

func TestResolveSizeAutoWithReference(t *testing.T) {
	ref := domain.PixelSize{Width: 900, Height: 1200}
	got, err := images.ResolveSize("auto", "", &ref, "1K")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Mode != "exact" || got.Exact == nil || got.Exact.Width != 900 || got.Exact.Height != 1200 {
		t.Fatalf("expected exact 900x1200, got %+v", got)
	}
	if got.Tier != "1K" || got.DerivedRatio != "3:4" || got.Expected.Width != 864 || got.Expected.Height != 1152 {
		t.Fatalf("unexpected tier/ratio/expected: %+v", got)
	}
}

func TestResolveSizeTierWithoutRatio(t *testing.T) {
	got, err := images.ResolveSize("2K", "", nil, "1K")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Mode != "tier" || got.Tier != "2K" || got.Ratio != nil {
		t.Fatalf("unexpected: %+v", got)
	}
	if got.Expected.Width != 2048 || got.Expected.Height != 2048 {
		t.Fatalf("expected 2048x2048, got %+v", got.Expected)
	}
}

func TestResolveSizeExplicitPixel(t *testing.T) {
	got, err := images.ResolveSize("1024x1024", "", nil, "1K")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Tier != "1K" || got.DerivedRatio != "1:1" || got.Ratio == nil || *got.Ratio != "1:1" {
		t.Fatalf("unexpected: %+v", got)
	}
	if got.Expected.Width != 1024 || got.Expected.Height != 1024 || got.Exact != nil {
		t.Fatalf("unexpected expected: %+v", got)
	}
}

func TestResolveSizeTierWithRatio(t *testing.T) {
	got, err := images.ResolveSize("2K", "16:9", nil, "1K")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Ratio == nil || *got.Ratio != "16:9" {
		t.Fatalf("ratio = %v", got.Ratio)
	}
	if got.Expected.Width != 2624 || got.Expected.Height != 1472 {
		t.Fatalf("expected 2624x1472, got %+v", got.Expected)
	}
}

func TestResolveSizeDefaultTier(t *testing.T) {
	got, err := images.ResolveSize("", "", nil, "3K")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Tier != "3K" || got.Expected.Width != 3072 || got.Expected.Height != 3072 {
		t.Fatalf("unexpected default tier: %+v", got)
	}
}

func TestResolveSizeRejectsInvalid(t *testing.T) {
	for _, tc := range []struct{ size, ratio string }{
		{"8K", ""},
		{"0x0", ""},
		{"1024", ""},
		{"abc", ""},
		{"1K", "5:4"},
	} {
		if _, err := images.ResolveSize(tc.size, tc.ratio, nil, "1K"); err == nil {
			t.Fatalf("size=%q ratio=%q accepted", tc.size, tc.ratio)
		}
	}
}

func TestFormatRequestSize(t *testing.T) {
	exact, _ := images.ResolveSize("auto", "", &domain.PixelSize{Width: 900, Height: 1200}, "1K")
	if got := images.FormatRequestSize(exact); got != "900x1200" {
		t.Fatalf("exact format = %q", got)
	}
	tier, _ := images.ResolveSize("2K", "16:9", nil, "1K")
	if got := images.FormatRequestSize(tier); got != "2K 16:9" {
		t.Fatalf("tier format = %q", got)
	}
	plain, _ := images.ResolveSize("2K", "", nil, "1K")
	if got := images.FormatRequestSize(plain); got != "2K" {
		t.Fatalf("plain format = %q", got)
	}
}
