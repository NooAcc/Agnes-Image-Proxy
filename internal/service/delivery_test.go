package service_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func requireLocalStorage(t *testing.T, s *store.Store) {
	t.Helper()
	if _, err := s.InitializeStorage(context.Background(), domain.StorageInit{Mode: domain.StorageLocal}); err != nil {
		t.Fatalf("initialize local storage: %v", err)
	}
}

type deliveryDownloadFunc func(context.Context, string) ([]byte, string, error)

func (f deliveryDownloadFunc) Download(ctx context.Context, url string) ([]byte, string, error) {
	return f(ctx, url)
}

type deliverySaveFunc func(context.Context, domain.GalleryInsert) (domain.StoredImage, error)

func (f deliverySaveFunc) SaveDeliveryImage(ctx context.Context, in domain.GalleryInsert, includeOriginal bool) (domain.StoredImage, []byte, error) {
	stored, err := f(ctx, in)
	if !includeOriginal || err != nil {
		return stored, nil, err
	}
	return stored, in.Image, nil
}

type deliveryAuthoritativeSave func(context.Context, domain.GalleryInsert, bool) (domain.StoredImage, []byte, error)

func (f deliveryAuthoritativeSave) SaveDeliveryImage(ctx context.Context, in domain.GalleryInsert, includeOriginal bool) (domain.StoredImage, []byte, error) {
	return f(ctx, in, includeOriginal)
}
func deliveryInput() service.DeliveryInput {
	return service.DeliveryInput{RequestID: "request", SubrequestIndex: 2, ImageIndex: 1, Model: "m", Prompt: "p", ExpectedSize: "1K", SourceURL: "https://source.example/image.png", AccountID: 7, AccountName: "account"}
}
func TestDeliveryPersistsBeforeReturn(t *testing.T) {
	data := testutil.PNG(t, 4, 4)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	d := service.NewDelivery(service.DeliveryOptions{Downloader: deliveryDownloadFunc(func(ctx context.Context, url string) ([]byte, string, error) { return data, "image/png", nil }), Store: deliverySaveFunc(func(ctx context.Context, in domain.GalleryInsert) (domain.StoredImage, error) {
		if !bytes.Equal(in.Image, data) || in.OutputKey != "request:2:1" || in.AccountID == nil || *in.AccountID != 7 {
			t.Error("persisted arguments", in)
		}
		close(entered)
		<-release
		return domain.StoredImage{ID: 1, PublicID: "0123456789abcdef0123456789abcdef", MIME: "image/png", Bytes: int64(len(data))}, nil
	})})
	go func() {
		result, err := d.Deliver(context.Background(), deliveryInput())
		if err == nil && (result.Stored.ID != 1 || result.Base64 != nil) {
			err = errors.New("invalid delivery result")
		}
		done <- err
	}()
	<-entered
	select {
	case err := <-done:
		t.Fatal("returned before save", err)
	default:
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestDeliveryBase64MatchesOriginal(t *testing.T) {
	data := testutil.PNG(t, 4, 4)
	s, constructErr := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	requireLocalStorage(t, s)
	d := service.NewDelivery(service.DeliveryOptions{Store: s, Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) { return data, "image/png", nil })})
	in := deliveryInput()
	in.IncludeBase64 = true
	result, err := d.Deliver(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if result.Base64 == nil {
		t.Fatal("base64 missing")
	}
	decoded, err := base64.StdEncoding.DecodeString(*result.Base64)
	if err != nil || !bytes.Equal(decoded, data) {
		t.Fatal("base64 mismatch", err)
	}
	saved, _, err := s.GalleryContent(context.Background(), result.Stored.ID, false)
	if err != nil || !bytes.Equal(saved, decoded) {
		t.Fatal("stored original mismatch", err)
	}
}
func TestDeliveryRetriesDownloadOnly(t *testing.T) {
	data := testutil.PNG(t, 4, 4)
	downloads, saves := 0, 0
	d := service.NewDelivery(service.DeliveryOptions{Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) {
		downloads++
		if downloads == 1 {
			return nil, "", &images.DownloadError{Status: 429, Retryable: true, Err: errors.New("rate limited")}
		}
		return data, "image/png", nil
	}), Store: deliverySaveFunc(func(context.Context, domain.GalleryInsert) (domain.StoredImage, error) {
		saves++
		return domain.StoredImage{ID: 1}, nil
	})})
	if _, err := d.Deliver(context.Background(), deliveryInput()); err != nil {
		t.Fatal(err)
	}
	if downloads != 2 || saves != 1 {
		t.Fatalf("downloads=%d saves=%d", downloads, saves)
	}
}
func TestDeliveryDeterministicFailureNoRetry(t *testing.T) {
	for _, tc := range []struct {
		data []byte
		mime string
		err  error
	}{{nil, "", &images.DownloadError{Err: errors.New("private address")}}, {[]byte("not image"), "image/png", nil}, {testutil.PNG(t, 4, 4), "image/jpeg", nil}} {
		downloads, saves := 0, 0
		d := service.NewDelivery(service.DeliveryOptions{Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) { downloads++; return tc.data, tc.mime, tc.err }), Store: deliverySaveFunc(func(context.Context, domain.GalleryInsert) (domain.StoredImage, error) {
			saves++
			return domain.StoredImage{}, nil
		})})
		_, err := d.Deliver(context.Background(), deliveryInput())
		var ae *apierror.Error
		if !errors.As(err, &ae) || ae.Status != 502 || downloads != 1 || saves != 0 {
			t.Fatalf("%v downloads=%d saves=%d", err, downloads, saves)
		}
	}
}
func TestDeliveryPersistenceFailureDoesNotRedownload(t *testing.T) {
	data := testutil.PNG(t, 4, 4)
	downloads := 0
	d := service.NewDelivery(service.DeliveryOptions{Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) { downloads++; return data, "image/png", nil }), Store: deliverySaveFunc(func(context.Context, domain.GalleryInsert) (domain.StoredImage, error) {
		return domain.StoredImage{}, errors.New("secret database URL")
	})})
	_, err := d.Deliver(context.Background(), deliveryInput())
	var ae *apierror.Error
	if !errors.As(err, &ae) || ae.Status != 503 || ae.Code == nil || *ae.Code != "image_persist_failed" || downloads != 1 || ae.Message == "secret database URL" {
		t.Fatalf("%v downloads=%d", err, downloads)
	}
}
func TestDeliveryCanceledRetry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var downloads atomic.Int64
	d := service.NewDelivery(service.DeliveryOptions{Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) {
		downloads.Add(1)
		cancel()
		return nil, "", &images.DownloadError{Retryable: true, Err: errors.New("temporary")}
	})})
	started := time.Now()
	_, err := d.Deliver(ctx, deliveryInput())
	if !errors.Is(err, context.Canceled) || time.Since(started) > 100*time.Millisecond || downloads.Load() != 1 {
		t.Fatalf("%v %v", err, time.Since(started))
	}
}
func TestDeliveryCanceledAmbiguousCommitKeepsOriginal(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, constructErr := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	requireLocalStorage(t, s)
	data := testutil.PNG(t, 4, 4)
	downloads := 0
	d := service.NewDelivery(service.DeliveryOptions{Store: deliveryAuthoritativeSave(func(ctx context.Context, in domain.GalleryInsert, includeOriginal bool) (domain.StoredImage, []byte, error) {
		_, _, err := s.SaveDeliveryImage(ctx, in, includeOriginal)
		if err != nil {
			return domain.StoredImage{}, nil, err
		}
		cancel()
		return domain.StoredImage{}, nil, context.Canceled
	}), Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) { downloads++; return data, "image/png", nil })})
	if _, err := d.Deliver(ctx, deliveryInput()); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation hidden", err)
	}
	page, err := s.ListGallery(context.Background(), domain.CursorQuery{})
	if err != nil || len(page.Items) != 1 || downloads != 1 {
		t.Fatal("committed original removed or regenerated", err, downloads)
	}
	stored, _, err := s.GalleryContent(context.Background(), page.Items[0].ID, false)
	if err != nil || !bytes.Equal(stored, data) {
		t.Fatal("committed bytes lost", err)
	}
}

func TestDeliveryAmbiguousWriteChangedBodyUsesStoredBase64(t *testing.T) {
	ctx := context.Background()
	s, constructErr := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	requireLocalStorage(t, s)
	a, b := testutil.PNG(t, 4, 4), testutil.PNG(t, 5, 5)
	downloads, saves := 0, 0
	d := service.NewDelivery(service.DeliveryOptions{Store: deliveryAuthoritativeSave(func(ctx context.Context, in domain.GalleryInsert, includeOriginal bool) (domain.StoredImage, []byte, error) {
		saves++
		stored, original, err := s.SaveDeliveryImage(ctx, in, includeOriginal)
		if saves == 1 && err == nil {
			return domain.StoredImage{}, nil, errors.New("timeout after commit")
		}
		return stored, original, err
	}), Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) {
		downloads++
		if downloads == 1 {
			return a, "image/png", nil
		}
		return b, "image/png", nil
	})})
	in := deliveryInput()
	in.IncludeBase64 = true
	if _, err := d.Deliver(ctx, in); err == nil {
		t.Fatal("expected ambiguous failure")
	}
	result, err := d.Deliver(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(*result.Base64)
	stored, _, readErr := s.PublicImageContent(ctx, result.Stored.PublicID)
	if err != nil || readErr != nil || !bytes.Equal(decoded, stored) || !bytes.Equal(stored, a) {
		t.Fatal("successful base64 differs from stored original")
	}
	page, err := s.ListGallery(ctx, domain.CursorQuery{})
	if err != nil || len(page.Items) != 1 {
		t.Fatal("duplicate original", err)
	}
}

func TestDeliveryAmbiguousWriteRetryIsIdempotent(t *testing.T) {
	db := testutil.OpenDB(t)
	s, constructErr := store.New(db, store.NewOptions{DataDir: t.TempDir()})
	if constructErr != nil {
		t.Fatal(constructErr)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	requireLocalStorage(t, s)
	calls := 0
	var saved domain.StoredImage
	data := testutil.PNG(t, 4, 4)
	d := service.NewDelivery(service.DeliveryOptions{Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) { return data, "image/png", nil }), Store: deliverySaveFunc(func(ctx context.Context, in domain.GalleryInsert) (domain.StoredImage, error) {
		calls++
		result, err := s.SaveGeneratedImage(ctx, in)
		saved = result
		if calls == 1 && err == nil {
			return domain.StoredImage{}, errors.New("write timeout after commit")
		}
		return result, err
	})})
	if _, err := d.Deliver(ctx, deliveryInput()); err == nil {
		t.Fatal("ambiguous failure hidden")
	}
	result, err := d.Deliver(ctx, deliveryInput())
	if err != nil || result.Stored != saved {
		t.Fatalf("retry: %+v %v", result, err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM gallery").Scan(&count); err != nil || count != 1 {
		t.Fatalf("rows=%d %v", count, err)
	}
}
