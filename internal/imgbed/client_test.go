package imgbed

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/safehttp"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

const testPublicID = "0123456789abcdef0123456789abcdef"

type staticResolver struct{ ip net.IP }

func (s staticResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: s.ip}}, nil
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func newTestClient(t *testing.T, transport http.RoundTripper, now func() time.Time) *Client {
	t.Helper()
	client, err := New(domain.StorageConfig{
		Mode:          domain.StorageImgbed,
		ImgbedBaseURL: "https://img.example.com",
		ImgbedToken:   "tok",
	}, Options{
		HTTP: safehttp.Options{
			Resolver:  staticResolver{ip: net.ParseIP("93.184.216.34")},
			Transport: transport,
		},
		Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func response(status int, contentType string, body []byte) *http.Response {
	header := http.Header{}
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	return &http.Response{
		StatusCode:    status,
		Header:        header,
		Body:          io.NopCloser(strings.NewReader(string(body))),
		ContentLength: int64(len(body)),
	}
}

func uploadResponse(src string) []byte {
	return []byte(`[{"src":"` + src + `"}]`)
}

func fixedNow() time.Time { return time.Date(2026, 11, 25, 15, 59, 59, 0, time.UTC) }

func TestUploadRequestContract(t *testing.T) {
	data := testutil.PNG(t, 2, 2)
	src := "https://img.example.com/file/agnes-image-proxy/2026-11-25/" + testPublicID + ".png"
	var posted bool
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.Method {
		case http.MethodPost:
			posted = true
			if r.URL.Path != "/upload" {
				t.Errorf("path = %q", r.URL.Path)
			}
			query := r.URL.Query()
			if len(query) != 3 {
				t.Errorf("query = %v", query)
			}
			want := map[string]string{
				"serverCompress": "false",
				"returnFormat":   "full",
				"uploadFolder":   "agnes-image-proxy/2026-11-25",
			}
			for key, value := range want {
				if got := query.Get(key); got != value {
					t.Errorf("%s = %q, want %q", key, got, value)
				}
			}
			if got := r.Header.Get("Authorization"); got != "Bearer tok" {
				t.Errorf("Authorization = %q", got)
			}
			reader, err := r.MultipartReader()
			if err != nil {
				t.Fatalf("multipart: %v", err)
			}
			part, err := reader.NextPart()
			if err != nil {
				t.Fatalf("part: %v", err)
			}
			if part.FormName() != "file" || part.FileName() != testPublicID+".png" || part.Header.Get("Content-Type") != "image/png" {
				t.Errorf("part name=%q file=%q type=%q", part.FormName(), part.FileName(), part.Header.Get("Content-Type"))
			}
			got, err := io.ReadAll(part)
			if err != nil || string(got) != string(data) {
				t.Errorf("part bytes differ: %v", err)
			}
			if extra, err := reader.NextPart(); err != io.EOF {
				t.Errorf("unexpected extra part %v, %v", extra, err)
			}
			return response(http.StatusOK, "application/json", uploadResponse(src)), nil
		case http.MethodGet:
			if r.URL.Path != "/file/agnes-image-proxy/2026-11-25/"+testPublicID+".png" {
				t.Errorf("read path = %q", r.URL.Path)
			}
			if r.Header.Get("Authorization") != "" {
				t.Error("public read sent an Authorization header")
			}
			return response(http.StatusOK, "image/png", data), nil
		}
		t.Fatalf("unexpected method %s", r.Method)
		return nil, nil
	})
	client := newTestClient(t, transport, fixedNow)
	object, verified, err := client.Upload(context.Background(), testPublicID, "image/png", data)
	if err != nil {
		t.Fatal(err)
	}
	if !posted || object.Ref != "agnes-image-proxy/2026-11-25/"+testPublicID+".png" ||
		object.MIME != "image/png" || object.Bytes != int64(len(data)) || string(verified) != string(data) {
		t.Fatalf("object = %+v posted=%v", object, posted)
	}
}

func TestUploadCrossMidnightKeepsRef(t *testing.T) {
	data := testutil.PNG(t, 2, 2)
	before := time.Date(2026, 11, 25, 15, 59, 59, 0, time.UTC)
	after := before.Add(time.Second)
	calls := 0
	now := func() time.Time {
		calls++
		if calls == 1 {
			return before
		}
		return after
	}
	var folders []string
	var deletePath string
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch {
		case r.Method == http.MethodPost:
			folders = append(folders, r.URL.Query().Get("uploadFolder"))
			return response(http.StatusOK, "application/json", uploadResponse(
				"https://img.example.com/file/agnes-image-proxy/2026-11-25/"+testPublicID+".png")), nil
		case strings.HasPrefix(r.URL.Path, "/file/"):
			if !strings.Contains(r.URL.Path, "/2026-11-25/") {
				t.Errorf("read used a different folder: %q", r.URL.Path)
			}
			return response(http.StatusOK, "image/png", testutil.PNG(t, 3, 3)), nil
		case strings.HasPrefix(r.URL.Path, "/api/manage/delete/"):
			deletePath = r.URL.EscapedPath()
			return response(http.StatusOK, "application/json", []byte(`{"success":true,"existed":true}`)), nil
		}
		t.Fatalf("unexpected request %s %s", r.Method, r.URL)
		return nil, nil
	})
	client := newTestClient(t, transport, now)
	_, _, err := client.Upload(context.Background(), testPublicID, "image/png", data)
	if err == nil {
		t.Fatal("mismatched read-back was accepted")
	}
	if len(folders) != 1 || folders[0] != "agnes-image-proxy/2026-11-25" {
		t.Fatalf("folders = %v", folders)
	}
	if !strings.Contains(deletePath, "/2026-11-25/") {
		t.Fatalf("candidate cleanup used %q", deletePath)
	}
}

func TestUploadResponseIdentity(t *testing.T) {
	data := testutil.PNG(t, 2, 2)
	good := "https://img.example.com/file/agnes-image-proxy/2026-11-25/" + testPublicID + ".png"
	large := append([]byte(`[{"src":"`+good+`"}]`), []byte(strings.Repeat(" ", (1<<20)+1))...)
	cases := map[string]struct {
		status int
		body   []byte
	}{
		"object":        {200, []byte(`{"src":"` + good + `"}`)},
		"empty":         {200, []byte(`[]`)},
		"two items":     {200, []byte(string(uploadResponse(good))[:len(uploadResponse(good))-1] + `,{"src":"` + good + `"}]`)},
		"relative":      {200, uploadResponse("/file/agnes-image-proxy/2026-11-25/a.png")},
		"other origin":  {200, uploadResponse("https://evil.example/file/agnes-image-proxy/2026-11-25/a.png")},
		"wrong date":    {200, uploadResponse("https://img.example.com/file/agnes-image-proxy/2026-11-26/a.png")},
		"too large":     {200, large},
		"trailing json": {200, append(uploadResponse(good), []byte(` {}`)...)},
		"short link":    {200, uploadResponse("https://img.example.com/s/" + testPublicID)},
		"expires":       {200, []byte(`[{"src":"` + good + `","expiresAt":"2026-12-01T00:00:00Z"}]`)},
		"server error":  {500, []byte(`[]`)},
		"redirect":      {302, []byte(``)},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			reads := 0
			transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.Method != http.MethodPost {
					reads++
				}
				return response(tc.status, "application/json", tc.body), nil
			})
			client := newTestClient(t, transport, fixedNow)
			if _, _, err := client.Upload(context.Background(), testPublicID, "image/png", data); err == nil {
				t.Fatal("invalid upload response accepted")
			}
			if reads != 0 {
				t.Fatalf("read-back ran for a rejected response: %d", reads)
			}
		})
	}
}

func TestUploadRequiresIdenticalReadback(t *testing.T) {
	data := testutil.PNG(t, 2, 2)
	src := "https://img.example.com/file/agnes-image-proxy/2026-11-25/" + testPublicID + ".png"
	cases := map[string]struct {
		mime string
		body []byte
	}{
		"different bytes": {"image/png", testutil.PNG(t, 3, 3)},
		"different mime":  {"image/jpeg", testutil.JPEG(t, 2, 2)},
		"not an image":    {"text/html", []byte("<html></html>")},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.Method == http.MethodPost {
					return response(http.StatusOK, "application/json", uploadResponse(src)), nil
				}
				return response(http.StatusOK, tc.mime, tc.body), nil
			})
			client := newTestClient(t, transport, fixedNow)
			if _, _, err := client.Upload(context.Background(), testPublicID, "image/png", data); err == nil {
				t.Fatal("mismatched read-back accepted")
			}
		})
	}
}

type failBody struct {
	read bool
}

func (b *failBody) Read([]byte) (int, error) {
	b.read = true
	return 0, errors.New("body must not be read")
}

func (b *failBody) Close() error { return nil }

func TestHeadNeverDownloadsBody(t *testing.T) {
	object := Object{Ref: "agnes-image-proxy/2026-11-25/a.png", MIME: "image/png", Bytes: 10}
	body := &failBody{}
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodHead {
			t.Fatalf("method = %s", r.Method)
		}
		return &http.Response{
			StatusCode:    200,
			Header:        http.Header{},
			Body:          body,
			ContentLength: -1,
		}, nil
	})
	client := newTestClient(t, transport, fixedNow)
	if err := client.Head(context.Background(), object); err != nil {
		t.Fatalf("unknown length HEAD failed: %v", err)
	}
	if body.read {
		t.Fatal("HEAD downloaded the body")
	}

	mismatch := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: &failBody{}, ContentLength: 5}, nil
	})
	if err := newTestClient(t, mismatch, fixedNow).Head(context.Background(), object); err == nil {
		t.Fatal("length mismatch accepted")
	}

	matching := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    200,
			Header:        http.Header{"Content-Type": {"image/png; charset=binary"}},
			Body:          &failBody{},
			ContentLength: 10,
		}, nil
	})
	if err := newTestClient(t, matching, fixedNow).Head(context.Background(), object); err != nil {
		t.Fatalf("matching HEAD failed: %v", err)
	}

	missing := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 404, Header: http.Header{}, Body: &failBody{}, ContentLength: -1}, nil
	})
	if err := newTestClient(t, missing, fixedNow).Head(context.Background(), object); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing HEAD = %v", err)
	}
}

func TestDeleteLogicalFailureAndMissing(t *testing.T) {
	ref := "agnes-image-proxy/2026-11-25/a b.png"
	cases := map[string]struct {
		status int
		body   string
		ok     bool
	}{
		"success":      {200, `{"success":true,"existed":true}`, true},
		"idempotent":   {200, `{"success":true,"existed":false}`, true},
		"logical fail": {200, `{"success":false,"error":"nope"}`, false},
		"forbidden":    {403, `{"success":false}`, false},
		"not found":    {404, ``, false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var seen string
			transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
				seen = r.URL.EscapedPath()
				if r.Method != http.MethodGet {
					t.Errorf("method = %s", r.Method)
				}
				if r.URL.RawQuery != "" {
					t.Errorf("delete carried a query: %q", r.URL.RawQuery)
				}
				if r.Header.Get("Authorization") != "Bearer tok" {
					t.Errorf("missing token")
				}
				return response(tc.status, "application/json", []byte(tc.body)), nil
			})
			err := newTestClient(t, transport, fixedNow).Delete(context.Background(), ref)
			if tc.ok && err != nil {
				t.Fatalf("delete failed: %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("delete unexpectedly succeeded")
			}
			if !strings.HasPrefix(seen, "/api/manage/delete/agnes-image-proxy/2026-11-25/a%20b.png") {
				t.Fatalf("delete path = %q", seen)
			}
		})
	}

	called := false
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		called = true
		return response(200, "application/json", []byte(`{"success":true}`)), nil
	})
	client := newTestClient(t, transport, fixedNow)
	for _, invalid := range []string{"", "../etc/passwd", "agnes-image-proxy/2026-11-25/../x", "agnes-image-proxy/2026-11-25/a/b"} {
		if err := client.Delete(context.Background(), invalid); err == nil {
			t.Fatalf("invalid ref %q accepted", invalid)
		}
	}
	if called {
		t.Fatal("invalid ref reached the network")
	}

	network := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("dial failed")
	})
	if err := newTestClient(t, network, fixedNow).Delete(context.Background(), ref); err == nil {
		t.Fatal("network failure treated as success")
	}
}

func TestUploadRejectsInvalidInputs(t *testing.T) {
	client := newTestClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("network should not be reached")
		return nil, nil
	}), fixedNow)
	for name, call := range map[string]func() error{
		"bad public id": func() error {
			_, _, err := client.Upload(context.Background(), "short", "image/png", []byte("x"))
			return err
		},
		"bad mime": func() error {
			_, _, err := client.Upload(context.Background(), testPublicID, "image/gif", []byte("x"))
			return err
		},
		"empty": func() error {
			_, _, err := client.Upload(context.Background(), testPublicID, "image/png", nil)
			return err
		},
	} {
		if err := call(); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if _, err := New(domain.StorageConfig{Mode: domain.StorageLocal}, Options{}); err == nil {
		t.Fatal("imgbed client accepted local configuration")
	}
}

func TestParseUploadSourceOriginPortNormalization(t *testing.T) {
	base := "https://img.example.com"
	ref, err := parseUploadSource("https://img.example.com:443/file/agnes-image-proxy/2026-11-25/a.png", base, "")
	if err != nil || ref != "agnes-image-proxy/2026-11-25/a.png" {
		t.Fatalf("port normalization: %q, %v", ref, err)
	}
	if _, err := url.Parse(base); err != nil {
		t.Fatal(err)
	}
	if _, err := fileURL(base, "file", "agnes-image-proxy/2026-11-25/a.png"); err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(ref); got == "" {
		t.Fatal("unreachable")
	}
}
