package imgbed

import (
	"strings"
	"testing"
	"time"
)

func TestPublicFileURL(t *testing.T) {
	ref := "agnes-image-proxy/2026-11-25/a b 中文%z.png"
	want := "https://img.example.com/file/agnes-image-proxy/2026-11-25/a%20b%20%E4%B8%AD%E6%96%87%25z.png"
	got, err := PublicFileURL("https://img.example.com", ref)
	if err != nil || got != want {
		t.Fatalf("URL = %q %v, want %q", got, err, want)
	}
	for _, origin := range []string{"http://img.example.com", "https://user:secret@img.example.com", "https://img.example.com/?secret=token"} {
		if _, err := PublicFileURL(origin, ref); err == nil {
			t.Fatalf("invalid origin accepted: %s", origin)
		}
	}
	if _, err := PublicFileURL("https://img.example.com", "../secret.png"); err == nil {
		t.Fatal("invalid ref accepted")
	}
}

func TestUploadFolderChinaTime(t *testing.T) {
	before := time.Date(2026, 11, 25, 15, 59, 59, 0, time.UTC)
	after := before.Add(time.Second)
	if got := uploadFolder(before); got != "agnes-image-proxy/2026-11-25" {
		t.Fatalf("before midnight folder = %q", got)
	}
	if got := uploadFolder(after); got != "agnes-image-proxy/2026-11-26" {
		t.Fatalf("after midnight folder = %q", got)
	}
	// The offset is fixed and independent of the process time zone.
	if _, offset := time.Date(2026, 11, 25, 15, 59, 59, 0, time.UTC).In(chinaZone).Zone(); offset != 8*60*60 {
		t.Fatalf("offset = %d", offset)
	}
}

func TestValidRef(t *testing.T) {
	for _, ref := range []string{
		"agnes-image-proxy/2026-11-25/abc.png",
		"agnes-image-proxy/2026-11-25/a b 中文%z.png",
	} {
		if !ValidRef(ref) {
			t.Fatalf("valid ref rejected: %q", ref)
		}
	}
	for _, ref := range []string{
		"",
		"agnes-image-proxy/2026-11-25",
		"agnes-image-proxy/2026-11-25/",
		"agnes-image-proxy/2026-13-25/a.png",
		"agnes-image-proxy/2026-02-30/a.png",
		"agnes-image-proxy/2026-11-25/../a.png",
		"agnes-image-proxy/2026-11-25/a/b.png",
		"other/2026-11-25/a.png",
		"agnes-image-proxy/2026-11-25/a\\b.png",
		"agnes-image-proxy/2026-11-25/a\x00b.png",
	} {
		if ValidRef(ref) {
			t.Fatalf("invalid ref accepted: %q", ref)
		}
	}
}

func TestRefRoundTripEncoding(t *testing.T) {
	base := "https://img.example.com"
	folder := "agnes-image-proxy/2026-11-25"
	for _, ref := range []string{
		"agnes-image-proxy/2026-11-25/a b 中文%z.png",
		"agnes-image-proxy/2026-11-25/plain.png",
	} {
		encoded, err := fileURL(base, "file", ref)
		if err != nil {
			t.Fatalf("fileURL(%q): %v", ref, err)
		}
		got, err := parseUploadSource(encoded, base, folder)
		if err != nil || got != ref {
			t.Fatalf("round trip %q -> %q, %v", ref, got, err)
		}
	}

	for name, src := range map[string]string{
		"encoded slash":     base + "/file/agnes-image-proxy/2026-11-25/a%2Fb.png",
		"encoded backslash": base + "/file/agnes-image-proxy/2026-11-25/a%5Cb.png",
		"dot dot":           base + "/file/agnes-image-proxy/2026-11-25/%2e%2e",
		"control":           base + "/file/agnes-image-proxy/2026-11-25/a%00b.png",
		"newline":           base + "/file/agnes-image-proxy/2026-11-25/a%0Ab.png",
		"empty segment":     base + "/file/agnes-image-proxy//2026-11-25/a.png",
		"double encoded":    base + "/file/agnes-image-proxy/2026-11-25/a%252Fb.png",
		"different origin":  "https://evil.example/file/agnes-image-proxy/2026-11-25/a.png",
		"wrong folder":      base + "/file/agnes-image-proxy/2026-11-26/a.png",
		"query":             base + "/file/agnes-image-proxy/2026-11-25/a.png?x=1",
		"fragment":          base + "/file/agnes-image-proxy/2026-11-25/a.png#x",
		"userinfo":          "https://u:p@img.example.com/file/agnes-image-proxy/2026-11-25/a.png",
		"not file path":     base + "/s/agnes-image-proxy/2026-11-25/a.png",
		"http":              "http://img.example.com/file/agnes-image-proxy/2026-11-25/a.png",
	} {
		if _, err := parseUploadSource(src, base, folder); err == nil {
			t.Fatalf("%s: accepted %q", name, src)
		}
	}
	if !strings.HasPrefix(folder, "agnes-image-proxy/") {
		t.Fatal("unreachable")
	}
}
