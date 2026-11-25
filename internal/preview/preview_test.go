package preview

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

func TestPreviewLocalStorageCleanup(t *testing.T) {
	p, err := New(Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })
	root := p.dir
	entries, err := os.ReadDir(root + "/data/images")
	if err != nil {
		t.Fatal("preview image directory unavailable", err)
	}
	if len(entries) == 0 {
		t.Fatal("preview persisted no image files")
	}
	page, err := p.store.ListGallery(context.Background(), domain.CursorQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	readable := false
	for _, row := range page.Items {
		if row.Archived {
			data, _, err := p.store.GalleryContent(context.Background(), row.ID, false)
			if err != nil || len(data) == 0 {
				t.Fatal("preview original not readable", err)
			}
			readable = true
			break
		}
	}
	if !readable {
		t.Fatal("preview has no readable original")
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("preview root remains", err)
	}
}

func TestPreviewImageDeliveryContract(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC).Unix())
	p, err := New(Options{Now: func() time.Time { return time.Unix(clock.Load(), 0) }})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	client := newTestClient(t)
	loginPreview(t, client, p.URL)
	generate := func(endpoint, body string) map[string]json.RawMessage {
		req, _ := http.NewRequest("POST", p.URL+endpoint, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer preview")
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("generate: %d %s", resp.StatusCode, raw)
		}
		var out struct {
			Data []map[string]json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(raw, &out); err != nil || len(out.Data) != 1 {
			t.Fatal("bad response", string(raw), err)
		}
		return out.Data[0]
	}
	item := generate("/v1/images/generations", `{"model":"m","prompt":"signed contract"}`)
	var link string
	_ = json.Unmarshal(item["url"], &link)
	parsed, _ := url.Parse(link)
	expiry, _ := strconv.ParseInt(parsed.Query().Get("expires"), 10, 64)
	if expiry-clock.Load() != 86400 || !strings.HasPrefix(link, p.URL+"/v1/images/content/") {
		t.Fatal("wrong proxy link", link)
	}
	get, err := http.Get(link)
	if err != nil {
		t.Fatal(err)
	}
	original, _ := io.ReadAll(get.Body)
	get.Body.Close()
	if get.StatusCode != 200 || len(original) == 0 || get.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("signed content unavailable")
	}
	head, _ := http.Head(link)
	head.Body.Close()
	if head.StatusCode != 200 || head.ContentLength != int64(len(original)) {
		t.Fatal("HEAD wrong")
	}
	settingsRaw := doJSON(t, client, "GET", p.URL+"/admin/api/settings", "", 200)
	var settings map[string]any
	_ = json.Unmarshal(settingsRaw, &settings)
	settings["imageUrlTtlHours"] = 1
	nextRaw, _ := json.Marshal(settings)
	doJSON(t, client, "PUT", p.URL+"/admin/api/settings", string(nextRaw), 200)
	editBody, _ := json.Marshal(map[string]any{"model": "m", "prompt": "signed edit", "size": "auto", "image": link})
	edit := generate("/v1/images/edits", string(editBody))
	var nextLink string
	_ = json.Unmarshal(edit["url"], &nextLink)
	nextURL, _ := url.Parse(nextLink)
	nextExpiry, _ := strconv.ParseInt(nextURL.Query().Get("expires"), 10, 64)
	if nextExpiry-clock.Load() != 3600 {
		t.Fatal("new TTL ignored")
	}
	b64 := generate("/v1/images/generations", `{"model":"m","prompt":"base64 contract","response_format":"b64_json"}`)
	var encoded string
	_ = json.Unmarshal(b64["b64_json"], &encoded)
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(decoded) == 0 {
		t.Fatal("base64 invalid")
	}
	page := doJSON(t, client, "GET", p.URL+"/admin/api/gallery?limit=100", "", 200)
	var gallery struct {
		Items []struct {
			ID     int64  `json:"id"`
			Prompt string `json:"prompt"`
		}
	}
	_ = json.Unmarshal(page, &gallery)
	var originalID int64
	for _, row := range gallery.Items {
		if row.Prompt == "base64 contract" {
			body := doJSON(t, client, "GET", fmt.Sprintf("%s/admin/api/gallery/%d/content", p.URL, row.ID), "", 200)
			if !bytes.Equal(body, decoded) {
				t.Fatal("base64 not stored original")
			}
		}
		if row.Prompt == "signed contract" {
			originalID = row.ID
		}
	}
	clock.Add(86400)
	expired, _ := http.Get(link)
	expired.Body.Close()
	if expired.StatusCode != 404 {
		t.Fatal("expired link accepted")
	}
	if originalID == 0 {
		t.Fatal("original not persisted")
	}
	doJSON(t, client, "GET", fmt.Sprintf("%s/admin/api/gallery/%d/content", p.URL, originalID), "", 200)
	doJSON(t, client, "DELETE", fmt.Sprintf("%s/admin/api/gallery/%d", p.URL, originalID), "", 204)
	clock.Add(-86400)
	deleted, _ := http.Get(link)
	deleted.Body.Close()
	if deleted.StatusCode != 404 {
		t.Fatal("deleted link accepted")
	}
}

func newTestClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	return &http.Client{Jar: jar, Timeout: 10 * time.Second}
}

func waitForHealth(t *testing.T, baseURL string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(baseURL + "/health")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("preview did not become healthy at %s", baseURL)
}

func doJSON(t *testing.T, client *http.Client, method, target, body string, want int) []byte {
	t.Helper()
	req, err := http.NewRequest(method, target, strings.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if method == "PUT" || method == "DELETE" {
		parsed, _ := url.Parse(target)
		req.Header.Set("Origin", parsed.Scheme+"://"+parsed.Host)
	}
	if body == "" {
		req.Header.Del("Content-Type")
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, target, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		t.Fatalf("%s %s status = %d, want %d (body %s)", method, target, resp.StatusCode, want, data)
	}
	return data
}

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for x := 0; x < 4; x++ {
		for y := 0; y < 4; y++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 40), G: uint8(y * 40), B: 128, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buffer.Bytes()
}

func loginPreview(t *testing.T, client *http.Client, baseURL string) {
	t.Helper()
	doJSON(t, client, http.MethodPost, baseURL+"/admin/api/session", `{"apiKey":"preview"}`, http.StatusOK)
}

func TestPreviewServesOfflineGenerateAndEdits(t *testing.T) {
	p, err := New(Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = p.Close() }()
	waitForHealth(t, p.URL)

	client := newTestClient(t)
	loginPreview(t, client, p.URL)

	doJSON(t, client, http.MethodGet, p.URL+"/admin/api/accounts", "", http.StatusOK)
	doJSON(t, client, http.MethodGet, p.URL+"/admin/api/settings", "", http.StatusOK)

	models := doJSON(t, client, http.MethodGet, p.URL+"/v1/models", "", http.StatusOK)
	if !bytes.Contains(models, []byte("agnes-image-2.5-flash")) {
		t.Fatalf("models response missing preview model: %s", models)
	}

	authClient := &http.Client{Timeout: 15 * time.Second}
	request, _ := http.NewRequest(http.MethodPost, p.URL+"/v1/images/generations",
		strings.NewReader(`{"model":"agnes-image-2.5-flash","prompt":"preview cat","n":2}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer preview")
	response, err := authClient.Do(request)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("generate status = %d, body %s", response.StatusCode, body)
	}
	var generated struct {
		Data []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &generated); err != nil {
		t.Fatalf("decode generate: %v", err)
	}
	if len(generated.Data) != 2 {
		t.Fatalf("generated %d images, want 2 (body %s)", len(generated.Data), body)
	}

	var form bytes.Buffer
	writer := multipart.NewWriter(&form)
	_ = writer.WriteField("model", "agnes-image-2.5-flash")
	_ = writer.WriteField("prompt", "preview edit")
	part, err := writer.CreateFormFile("image", "input.png")
	if err != nil {
		t.Fatalf("form file: %v", err)
	}
	if _, err := part.Write(tinyPNG(t)); err != nil {
		t.Fatalf("write image: %v", err)
	}
	_ = writer.Close()

	editRequest, _ := http.NewRequest(http.MethodPost, p.URL+"/v1/images/edits", &form)
	editRequest.Header.Set("Content-Type", writer.FormDataContentType())
	editRequest.Header.Set("Authorization", "Bearer preview")
	editResponse, err := authClient.Do(editRequest)
	if err != nil {
		t.Fatalf("edits: %v", err)
	}
	editBody, _ := io.ReadAll(editResponse.Body)
	_ = editResponse.Body.Close()
	if editResponse.StatusCode != http.StatusOK {
		t.Fatalf("edits status = %d, body %s", editResponse.StatusCode, editBody)
	}

	// The archive handoff runs after the response; the gallery must eventually
	// include all three generated images.
	deadline := time.Now().Add(5 * time.Second)
	for {
		page := doJSON(t, client, http.MethodGet, p.URL+"/admin/api/gallery", "", http.StatusOK)
		var listing struct {
			Items []struct {
				EnrichStatus string `json:"enrichStatus"`
				Tag          string `json:"nsfwTag"`
			} `json:"items"`
		}
		if err := json.Unmarshal(page, &listing); err != nil {
			t.Fatalf("decode gallery: %v", err)
		}
		if len(listing.Items) >= 10 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("gallery has %d items, want at least 10 after generate+edits", len(listing.Items))
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestPreviewSeedsEveryCategoryAndStatus(t *testing.T) {
	p, err := New(Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = p.Close() }()
	waitForHealth(t, p.URL)

	client := newTestClient(t)
	loginPreview(t, client, p.URL)
	page := doJSON(t, client, http.MethodGet, p.URL+"/admin/api/gallery?limit=100", "", http.StatusOK)

	var listing struct {
		Items []struct {
			Tag          string `json:"nsfwTag"`
			EnrichStatus string `json:"enrichStatus"`
			Archived     bool   `json:"archived"`
			SourceURL    string `json:"sourceUrl"`
		} `json:"items"`
	}
	if err := json.Unmarshal(page, &listing); err != nil {
		t.Fatalf("decode gallery: %v", err)
	}
	tags := map[string]bool{}
	statuses := map[string]bool{}
	archived := 0
	for _, item := range listing.Items {
		tags[item.Tag] = true
		statuses[item.EnrichStatus] = true
		if item.Archived {
			archived++
		}
	}
	for _, want := range []string{"safe", "drawing", "sexy", "porn", "hentai"} {
		if !tags[want] {
			t.Fatalf("seeded gallery tags = %v, missing %q", tags, want)
		}
	}
	for _, want := range []string{"success", "failed", "pending"} {
		if !statuses[want] {
			t.Fatalf("seeded enrich statuses = %v, missing %q", statuses, want)
		}
	}
	if archived < 6 {
		t.Fatalf("archived rows = %d, want at least 6", archived)
	}

	logs := doJSON(t, client, http.MethodGet, p.URL+"/admin/api/logs?limit=100", "", http.StatusOK)
	for _, want := range []string{`"category":"request"`, `"category":"enrich"`, `"ok":false`} {
		if !bytes.Contains(logs, []byte(want)) {
			t.Fatalf("seeded logs missing %s: %s", want, logs)
		}
	}
}

func TestPreviewRejectsWrongCredentials(t *testing.T) {
	p, err := New(Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = p.Close() }()
	waitForHealth(t, p.URL)

	client := newTestClient(t)
	doJSON(t, client, http.MethodPost, p.URL+"/admin/api/session", `{"apiKey":"wrong"}`, http.StatusUnauthorized)

	response, err := http.Post(p.URL+"/v1/images/generations", "application/json",
		strings.NewReader(`{"model":"agnes-image-2.5-flash","prompt":"preview"}`))
	if err != nil {
		t.Fatalf("generations: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("generations without bearer = %d, want 401", response.StatusCode)
	}
}

func TestPreviewCloseReleasesEverything(t *testing.T) {
	p, err := New(Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	waitForHealth(t, p.URL)
	baseURL := p.URL

	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if _, err := http.Get(baseURL + "/health"); err == nil {
		t.Fatal("preview still answers after Close")
	}
	if p.dir != "" {
		if _, err := os.Stat(p.dir); !os.IsNotExist(err) {
			t.Fatalf("preview temp dir %s still exists (err %v)", p.dir, err)
		}
	}
}

func TestPreviewInfoNamesOnlyTheMockKey(t *testing.T) {
	p, err := New(Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = p.Close() }()
	if !strings.Contains(p.URL, "127.0.0.1") {
		t.Fatalf("preview URL = %q, want loopback", p.URL)
	}
	if AdminAPIKey != "preview" {
		t.Fatalf("AdminAPIKey = %q", AdminAPIKey)
	}
	fmt.Fprint(io.Discard, p.URL)
}
