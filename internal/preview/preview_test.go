package preview

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"testing"
	"time"
)

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

func doJSON(t *testing.T, client *http.Client, method, url, body string, want int) []byte {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if body == "" {
		req.Header.Del("Content-Type")
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		t.Fatalf("%s %s status = %d, want %d (body %s)", method, url, resp.StatusCode, want, data)
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
