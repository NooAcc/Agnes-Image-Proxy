package service_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func TestDeliveryOriginalMIMEMatrix(t *testing.T) {
	for _, tc := range []struct {
		mime string
		data []byte
	}{
		{"image/png", testutil.PNG(t, 4, 5)}, {"image/jpeg", testutil.JPEG(t, 6, 7)}, {"image/webp", testutil.WebP(8, 9)},
	} {
		t.Run(tc.mime, func(t *testing.T) {
			s, constructErr := store.New(testutil.OpenDB(t), nil, t.TempDir())
			if constructErr != nil {
				t.Fatal(constructErr)
			}
			t.Cleanup(func() { _ = s.Close() })
			if err := s.EnsureSchema(context.Background()); err != nil {
				t.Fatal(err)
			}
			d := service.NewDelivery(service.DeliveryOptions{Store: s, Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) { return tc.data, tc.mime, nil })})
			in := deliveryInput()
			in.IncludeBase64 = true
			result, err := d.Deliver(context.Background(), in)
			if err != nil {
				t.Fatal(err)
			}
			stored, mime, err := s.PublicImageContent(context.Background(), result.Stored.PublicID)
			if err != nil || mime != tc.mime || !bytes.Equal(stored, tc.data) {
				t.Fatal("stored bytes changed", err)
			}
			decoded, err := base64.StdEncoding.Strict().DecodeString(*result.Base64)
			if err != nil || !bytes.Equal(decoded, stored) {
				t.Fatal("encoded bytes changed", err)
			}
		})
	}
}

func TestDeliveryRetrySharesDownloadDeadline(t *testing.T) {
	calls := 0
	var deadline time.Time
	data := testutil.PNG(t, 2, 2)
	d := service.NewDelivery(service.DeliveryOptions{Downloader: deliveryDownloadFunc(func(ctx context.Context, _ string) ([]byte, string, error) {
		calls++
		current, ok := ctx.Deadline()
		if !ok {
			t.Fatal("no download deadline")
		}
		if calls == 1 {
			deadline = current
			remaining := time.Until(current)
			if remaining <= 59*time.Second || remaining > 60*time.Second {
				t.Fatal("wrong total window", remaining)
			}
			return nil, "", &images.DownloadError{Retryable: true, Err: errors.New("temporary")}
		}
		if !current.Equal(deadline) {
			t.Fatal("retry reset the deadline")
		}
		return data, "image/png", nil
	}), Store: deliverySaveFunc(func(context.Context, domain.GalleryInsert) (domain.StoredImage, error) {
		return domain.StoredImage{ID: 1}, nil
	})})
	if _, err := d.Deliver(context.Background(), deliveryInput()); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("missing retry", calls)
	}
}

func TestDeliveryDownload64MiBBoundary(t *testing.T) {
	data := make([]byte, (64<<20)+1)
	copy(data, testutil.PNG(t, 2, 2))
	for _, size := range []int{64 << 20, (64 << 20) + 1} {
		saves := 0
		d := service.NewDelivery(service.DeliveryOptions{Downloader: deliveryDownloadFunc(func(context.Context, string) ([]byte, string, error) { return data[:size], "image/png", nil }), Store: deliverySaveFunc(func(context.Context, domain.GalleryInsert) (domain.StoredImage, error) {
			saves++
			return domain.StoredImage{ID: 1}, nil
		})})
		_, err := d.Deliver(context.Background(), deliveryInput())
		if (err == nil) != (size == 64<<20) || saves != btoi(size == 64<<20) {
			t.Fatalf("size=%d saves=%d error=%v", size, saves, err)
		}
	}
}
func btoi(value bool) int {
	if value {
		return 1
	}
	return 0
}
