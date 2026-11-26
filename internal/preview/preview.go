// Package preview runs the full console offline: an isolated SQLite database,
// a local mock Agnes/Edge upstream and the same runtime the production server
// uses. It never reads environment secrets or contacts real services.
package preview

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/app"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
)

// AdminAPIKey is the preview's intentionally public administrator credential.
const AdminAPIKey = "preview"

const (
	previewShutdownBudget = 120 * time.Second
	mockMaxDownloadBytes  = 32 << 20
)

// Options configures the preview server.
type Options struct {
	// Port selects the loopback listener. Zero picks an ephemeral port.
	Port   int
	Assets fs.FS
	Logf   func(format string, args ...any)
	Now    func() time.Time
}

// Preview is a running offline console.
type Preview struct {
	URL  string
	dir  string
	logf func(string, ...any)

	db       *sql.DB
	store    *store.Store
	runtime  *app.Runtime
	upstream *mockUpstream
	server   *http.Server

	closeOnce sync.Once
	closeErr  error
}

// New starts the offline stack on 127.0.0.1. Close releases everything.
func New(options Options) (*Preview, error) {
	logf := options.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}

	dir, err := os.MkdirTemp("", "agnes-preview-")
	if err != nil {
		return nil, fmt.Errorf("preview: create temp dir: %w", err)
	}
	cleanup := func() {
		_ = os.RemoveAll(dir)
	}

	dbPath := filepath.Join(dir, "preview.db")
	dsn := "file:" + dbPath + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("preview: open sqlite: %w", err)
	}
	st, err := store.New(db, store.NewOptions{Now: options.Now, DataDir: filepath.Join(dir, "data")})
	if err != nil {
		_ = db.Close()
		cleanup()
		return nil, fmt.Errorf("preview: image storage: %w", err)
	}

	upstream, err := newMockUpstream()
	if err != nil {
		_ = st.Close()
		cleanup()
		return nil, fmt.Errorf("preview: mock upstream: %w", err)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	runtime, err := app.NewRuntime(app.Options{
		Store:      st,
		Assets:     options.Assets,
		APIKey:     AdminAPIKey,
		Downloader: httpDownloader{client: client},
		HTTPClient: client,
		Logf:       logf,
		Now:        options.Now,
	})
	if err != nil {
		upstream.close()
		_ = st.Close()
		cleanup()
		return nil, fmt.Errorf("preview: runtime: %w", err)
	}

	if _, err := st.InitializeStorage(context.Background(), domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		upstream.close()
		_ = runtime.Shutdown(context.Background())
		cleanup()
		return nil, fmt.Errorf("preview: initialize local storage: %w", err)
	}

	seedCtx, seedCancel := context.WithTimeout(context.Background(), 15*time.Second)
	if err := seed(seedCtx, st, upstream); err != nil {
		seedCancel()
		_ = runtime.Shutdown(context.Background())
		upstream.close()
		cleanup()
		return nil, fmt.Errorf("preview: seed: %w", err)
	}
	seedCancel()

	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(options.Port))
	if err != nil {
		_ = runtime.Shutdown(context.Background())
		upstream.close()
		cleanup()
		return nil, fmt.Errorf("preview: listen: %w", err)
	}

	p := &Preview{
		URL:      "http://" + listener.Addr().String(),
		dir:      dir,
		logf:     logf,
		db:       db,
		store:    st,
		runtime:  runtime,
		upstream: upstream,
		server: &http.Server{
			Handler:           runtime.Handler(),
			ReadHeaderTimeout: 10 * time.Second,
		},
	}
	go func() {
		if err := p.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logf("preview server stopped: %v", err)
		}
	}()
	return p, nil
}

// Serve blocks until ctx ends and then shuts everything down.
func (p *Preview) Serve(ctx context.Context) error {
	<-ctx.Done()
	return p.Close()
}

// Close stops the HTTP server, drains accepted work, closes the database and
// removes the temporary directory. It is idempotent.
func (p *Preview) Close() error {
	p.closeOnce.Do(func() {
		var errs []error
		ctx, cancel := context.WithTimeout(context.Background(), previewShutdownBudget)
		defer cancel()

		p.runtime.StopAdmission()
		if err := p.server.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("preview: http shutdown: %w", err))
		}
		if err := p.runtime.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
		p.upstream.close()
		if err := os.RemoveAll(p.dir); err != nil {
			errs = append(errs, fmt.Errorf("preview: remove temp dir: %w", err))
		}
		p.closeErr = errors.Join(errs...)
	})
	return p.closeErr
}

// httpDownloader fetches mock output URLs. It is deliberately permissive about
// http because the preview upstream is a loopback httptest server; production
// keeps images.Remote with its https-only SSRF rules.
type httpDownloader struct {
	client *http.Client
}

func (d httpDownloader) Download(ctx context.Context, source string) ([]byte, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, "", err
	}
	response, err := d.client.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, "", fmt.Errorf("download status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, mockMaxDownloadBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > mockMaxDownloadBytes {
		return nil, "", fmt.Errorf("download exceeds %d bytes", mockMaxDownloadBytes)
	}
	mime := images.SniffImage(data)
	if mime == "" {
		return nil, "", errors.New("download is not png, jpeg or webp")
	}
	return data, mime, nil
}

// mockUpstream emulates the Agnes generation/models endpoints and the
// Edge-Images batch endpoint used for measurements and enrichment.
type mockUpstream struct {
	server *httptest.Server
	images map[string][]byte
	thumb  []byte
	seq    atomic.Int64
	nsfw   atomic.Int64
}

func newMockUpstream() (*mockUpstream, error) {
	pngData, err := encodePNG(64, 64, color.RGBA{R: 60, G: 120, B: 220, A: 255})
	if err != nil {
		return nil, err
	}
	jpegData, err := encodeJPEG(64, 64, color.RGBA{R: 220, G: 120, B: 60, A: 255})
	if err != nil {
		return nil, err
	}
	webpData := paddedWebP()
	thumb, err := encodePNG(8, 8, color.RGBA{R: 120, G: 200, B: 160, A: 255})
	if err != nil {
		return nil, err
	}

	m := &mockUpstream{
		images: map[string][]byte{"png": pngData, "jpeg": jpegData, "webp": webpData},
		thumb:  thumb,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/images/generations", m.handleGenerate)
	mux.HandleFunc("/v1/models", m.handleModels)
	mux.HandleFunc("/api/batch", m.handleBatch)
	mux.HandleFunc("/mock/", m.handleMockImage)
	m.server = httptest.NewServer(mux)
	return m, nil
}

func (m *mockUpstream) close() {
	if m != nil && m.server != nil {
		m.server.Close()
	}
}

func (m *mockUpstream) handleGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var payload struct {
		Model string `json:"model"`
		N     int    `json:"n"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload)
	n := payload.N
	if n < 1 {
		n = 1
	}
	if n > 4 {
		n = 4
	}
	formats := []string{"png", "jpeg", "webp"}
	data := make([]map[string]string, 0, n)
	for i := 0; i < n; i++ {
		id := m.seq.Add(1)
		format := formats[int((id-1)%int64(len(formats)))]
		data = append(data, map[string]string{
			"url": m.server.URL + "/mock/" + format + "/" + strconv.FormatInt(id, 10),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"created": time.Now().Unix(),
		"data":    data,
	})
}

func (m *mockUpstream) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"agnes-image-2.5-flash","object":"model","owned_by":"preview"}]}`))
}

var nsfwClasses = []map[string]any{
	{"drawing": 0.02, "hentai": 0.01, "safe": 0.90, "porn": 0.02, "sexy": 0.05, "isNsfw": false},
	{"drawing": 0.80, "hentai": 0.02, "safe": 0.10, "porn": 0.02, "sexy": 0.06, "isNsfw": false},
	{"drawing": 0.05, "hentai": 0.05, "safe": 0.05, "porn": 0.10, "sexy": 0.75, "isNsfw": true},
	{"drawing": 0.03, "hentai": 0.05, "safe": 0.02, "porn": 0.82, "sexy": 0.08, "isNsfw": true},
	{"drawing": 0.02, "hentai": 0.80, "safe": 0.05, "porn": 0.09, "sexy": 0.04, "isNsfw": true},
}

func (m *mockUpstream) handleBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var items []struct {
		UUID string `json:"uuid"`
		URL  string `json:"url"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(&items); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	// The seeded pending row is deliberately slow so the console's running
	// state and hidden-tab polling pause can be observed end to end.
	for _, item := range items {
		if strings.Contains(item.URL, "/pending") {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(3 * time.Second):
			}
		}
	}
	thumb := base64.StdEncoding.EncodeToString(m.thumb)
	results := make(map[string]any, len(items))
	for _, item := range items {
		index := m.nsfw.Add(1) - 1
		scores := nsfwClasses[int(index)%len(nsfwClasses)]
		results[item.UUID] = map[string]any{
			"success": true,
			"data": map[string]any{
				"width":             64,
				"height":            64,
				"format":            "png",
				"sourceContentType": "image/png",
				"base64":            thumb,
				"nsfw":              scores,
			},
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(results)
}

func (m *mockUpstream) handleMockImage(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/mock/"), "/")
	if len(parts) == 0 {
		http.NotFound(w, r)
		return
	}
	data, ok := m.images[parts[0]]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/"+parts[0])
	_, _ = w.Write(data)
}

func encodePNG(width, height int, base color.RGBA) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			img.Set(x, y, color.RGBA{
				R: uint8((int(base.R) + x*2) % 256),
				G: uint8((int(base.G) + y*2) % 256),
				B: base.B,
				A: 255,
			})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func encodeJPEG(width, height int, base color.RGBA) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			img.Set(x, y, color.RGBA{
				R: base.R,
				G: uint8((int(base.G) + x*2) % 256),
				B: uint8((int(base.B) + y*2) % 256),
				A: 255,
			})
		}
	}
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, img, &jpeg.Options{Quality: 80}); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// paddedWebP returns a valid 1x1 lossy WebP with an ignored JUNK chunk so the
// seeded WebP original is larger than its PNG thumbnail.
func paddedWebP() []byte {
	const onePixel = "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA="
	data, err := base64.StdEncoding.DecodeString(onePixel)
	if err != nil {
		panic("preview: invalid built-in webp")
	}
	padding := make([]byte, 512)
	chunk := make([]byte, 8+len(padding))
	copy(chunk[0:4], "JUNK")
	binary.LittleEndian.PutUint32(chunk[4:8], uint32(len(padding)))
	copy(chunk[8:], padding)

	out := make([]byte, 0, len(data)+len(chunk))
	out = append(out, data...)
	out = append(out, chunk...)
	// RIFF size covers everything after the first eight bytes.
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(out)-8))
	return out
}

func seed(ctx context.Context, st *store.Store, upstream *mockUpstream) error {
	settings := domain.DefaultSettings()
	settings.AgnesBaseURL = upstream.server.URL + "/v1"
	settings.ImageServiceBaseURL = upstream.server.URL
	if err := st.WriteSettings(ctx, settings); err != nil {
		return err
	}

	account, err := st.CreateAccount(ctx, "preview", "preview")
	if err != nil {
		return err
	}
	disabled := false
	if locked, err := st.CreateAccount(ctx, "preview-disabled", "preview-disabled"); err == nil {
		if _, err := st.UpdateAccount(ctx, locked.ID, domain.AccountPatch{Enabled: &disabled}); err != nil {
			return err
		}
	}
	if cooling, err := st.CreateAccount(ctx, "preview-cooling", "preview-cooling"); err == nil {
		if err := st.RecordFailure(ctx, cooling.ID, 30*time.Minute); err != nil {
			return err
		}
	}

	formats := []string{"png", "jpeg", "webp", "png", "jpeg", "webp"}
	prompts := []string{
		"preview: a friendly robot painting",
		"preview: a mountain at sunrise",
		"preview: a cat on a windowsill",
		"preview: abstract blue shapes",
		"preview: a quiet forest path",
		"preview: an image that failed enrichment",
	}
	tags := []string{"safe", "drawing", "sexy", "porn", "hentai"}
	tagNSFW := map[string]bool{"sexy": true, "porn": true, "hentai": true}
	actualSize := "64x64"

	for i, format := range formats {
		mime := "image/" + format
		source := fmt.Sprintf("%s/mock/%s/%d", upstream.server.URL, format, i+1)
		size := int64(len(upstream.images[format]))
		accountID := account.ID
		id, err := st.InsertGallery(ctx, domain.GalleryInsert{
			RequestID:   fmt.Sprintf("preview-seed-%d", i+1),
			OutputKey:   fmt.Sprintf("preview-seed-%d:0:0", i+1),
			Model:       "agnes-image-2.5-flash",
			Prompt:      prompts[i],
			SizeRequest: "1K",
			SizeActual:  &actualSize,
			AccountID:   &accountID,
			AccountName: account.Name,
			SourceURL:   &source,
			SourceMIME:  &mime,
			SourceBytes: &size,
			Image:       upstream.images[format],
			ImageMIME:   &mime,
		})
		if err != nil {
			return err
		}

		if i < len(tags) {
			tag := tags[i]
			scores := &domain.NSFWScores{Drawing: 0.02, Hentai: 0.02, Safe: 0.02, Porn: 0.02, Sexy: 0.02, IsNSFW: tagNSFW[tag]}
			switch tag {
			case "safe":
				scores.Safe = 0.9
			case "drawing":
				scores.Drawing = 0.9
			case "sexy":
				scores.Sexy = 0.9
			case "porn":
				scores.Porn = 0.9
			case "hentai":
				scores.Hentai = 0.9
			}
			if err := st.SetEnrichment(ctx, id, domain.EnrichmentWrite{
				Thumb:     upstream.thumb,
				ThumbMIME: "image/png",
				Status:    "success",
				Tag:       tag,
				Scores:    scores,
				At:        time.Now().UTC(),
			}); err != nil {
				return err
			}
		} else {
			message := "preview: mock classification timed out"
			if err := st.SetEnrichment(ctx, id, domain.EnrichmentWrite{
				Status: "failed",
				Error:  &message,
				At:     time.Now().UTC(),
			}); err != nil {
				return err
			}
		}
	}

	// One pending row so the backfill button has real work.
	pendingMIME := "image/png"
	pendingSource := upstream.server.URL + "/mock/png/pending"
	pendingSize := int64(len(upstream.images["png"]))
	accountID := account.ID
	if _, err := st.InsertGallery(ctx, domain.GalleryInsert{
		RequestID:   "preview-seed-pending",
		OutputKey:   "preview-seed-pending:0:0",
		Model:       "agnes-image-2.5-flash",
		Prompt:      "preview: waiting for enrichment",
		SizeRequest: "1K",
		SizeActual:  &actualSize,
		AccountID:   &accountID,
		AccountName: account.Name,
		SourceURL:   &pendingSource,
		SourceMIME:  &pendingMIME,
		SourceBytes: &pendingSize,
		Image:       upstream.images["png"],
		ImageMIME:   &pendingMIME,
	}); err != nil {
		return err
	}

	// A metadata-only row (no archived image) exercises the source-link view.
	unarchivedSource := upstream.server.URL + "/mock/png/unarchived"
	if _, err := st.InsertGallery(ctx, domain.GalleryInsert{
		RequestID:   "preview-seed-unarchived",
		OutputKey:   "preview-seed-unarchived:0:0",
		Model:       "agnes-image-2.5-flash",
		Prompt:      "preview: metadata only",
		SizeRequest: "1K",
		SizeActual:  &actualSize,
		AccountID:   &accountID,
		AccountName: account.Name,
		SourceURL:   &unarchivedSource,
	}); err != nil {
		return err
	}

	return seedLogs(ctx, st, account.ID, account.Name)
}

func seedLogs(ctx context.Context, st *store.Store, accountID int64, accountName string) error {
	now := time.Now().UTC()
	sizeRequest := "1K"
	sizeActual := "64x64"
	logs := []domain.RequestLog{
		{
			RequestID: "preview-seed-1", APIKeyName: "WEB", TS: now.Add(-4 * time.Minute),
			Endpoint: "generations", Path: "/v1/images/generations", Model: "agnes-image-2.5-flash",
			Status: 200, Requested: 1, Images: 1, DurationMS: 1200,
			SizeRequest: &sizeRequest, SizeActual: &sizeActual,
			Attempts: []domain.Attempt{{Index: 0, AccountID: accountID, AccountName: accountName, Status: 200, DurationMS: 1100}},
		},
		{
			RequestID: "preview-log-partial", APIKeyName: "preview-client", TS: now.Add(-2 * time.Hour),
			Endpoint: "generations", Path: "/v1/images/generations", Model: "agnes-image-2.5-flash",
			Status: 200, Requested: 3, Images: 2, Failed: 1, DurationMS: 2400,
			SizeRequest: &sizeRequest, SizeActual: &sizeActual,
			Attempts: []domain.Attempt{
				{Index: 0, AccountID: accountID, AccountName: accountName, Status: 200, DurationMS: 700},
				{Index: 1, AccountID: accountID, AccountName: accountName, Status: 200, DurationMS: 800},
				{Index: 2, AccountID: accountID, AccountName: accountName, Status: 503, Code: "upstream_unavailable", Message: "preview: simulated upstream error", DurationMS: 900},
			},
		},
		{
			RequestID: "preview-log-failure", TS: now.Add(-26 * time.Hour),
			Endpoint: "edits", Path: "/v1/images/edits", Model: "agnes-image-2.5-flash",
			Status: 502, Requested: 1, Images: 0, DurationMS: 900,
			Attempts: []domain.Attempt{{Index: 0, AccountID: accountID, AccountName: accountName, Status: 503, Code: "upstream_unavailable", Message: "preview: simulated outage", DurationMS: 900}},
		},
		{
			RequestID: "preview-log-parse", TS: now.Add(-26 * time.Hour),
			Stage: "parse", Endpoint: "generations", Path: "/v1/images/generations",
			Status: 400, Requested: 1, Images: 0, SizeRequest: &sizeRequest,
		},
	}
	for _, entry := range logs {
		if err := st.RecordRequest(ctx, entry); err != nil {
			return err
		}
	}

	enrichError := "preview: mock classification timed out"
	enrichment := []domain.RequestLog{
		{
			RequestID: "preview-seed-1", TS: now.Add(-90 * time.Minute),
			Stage: "archive", Endpoint: "enrich", Status: 200, Images: 1, DurationMS: 450,
		},
		{
			RequestID: "preview-enrich-failure", TS: now.Add(-30 * time.Hour),
			Stage: "backfill", Endpoint: "enrich", Status: 502, Images: 0, Failed: 1, DurationMS: 800,
			Attempts: []domain.Attempt{{Index: 0, Status: 502, Code: "enrich_failed", Message: enrichError, DurationMS: 800}},
		},
	}
	for _, entry := range enrichment {
		if err := st.RecordEnrichment(ctx, entry); err != nil {
			return err
		}
	}
	return nil
}
