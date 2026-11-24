package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

type DeliveryStore interface {
	SaveDeliveryImage(context.Context, domain.GalleryInsert, bool) (domain.StoredImage, []byte, error)
}
type DeliveryInput struct {
	RequestID                              string
	SubrequestIndex                        int64
	ImageIndex                             int
	Model, Prompt, ExpectedSize, SourceURL string
	AccountID                              int64
	AccountName                            string
	Measurement                            domain.Measurement
	IncludeBase64                          bool
}
type DeliveredImage struct {
	Stored      domain.StoredImage
	SourceURL   string
	Base64      *string
	Measurement domain.Measurement
}
type DeliveryOptions struct {
	Store      DeliveryStore
	Downloader Downloader
}
type Delivery struct {
	store      DeliveryStore
	downloader Downloader
}
type DeliveryRunner interface {
	Deliver(context.Context, DeliveryInput) (DeliveredImage, error)
}

func NewDelivery(options DeliveryOptions) *Delivery {
	return &Delivery{store: options.Store, downloader: options.Downloader}
}
func (d *Delivery) Deliver(ctx context.Context, in DeliveryInput) (DeliveredImage, error) {
	if err := ctx.Err(); err != nil {
		return DeliveredImage{}, err
	}
	if d.downloader == nil {
		return DeliveredImage{}, downloadFailure(errors.New("downloader unavailable"))
	}
	downloadCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var data []byte
	var mime string
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		data, mime, err = d.downloader.Download(downloadCtx, in.SourceURL)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return DeliveredImage{}, ctx.Err()
		}
		if downloadCtx.Err() != nil {
			return DeliveredImage{}, downloadFailure(downloadCtx.Err())
		}
		if attempt == 1 || !retryableDownload(err) {
			return DeliveredImage{}, downloadFailure(err)
		}
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-downloadCtx.Done():
			timer.Stop()
			if ctx.Err() != nil {
				return DeliveredImage{}, ctx.Err()
			}
			return DeliveredImage{}, downloadFailure(downloadCtx.Err())
		case <-timer.C:
		}
	}
	if err != nil {
		return DeliveredImage{}, downloadFailure(err)
	}
	sniffed := images.SniffImage(data)
	mime = strings.ToLower(strings.TrimSpace(strings.SplitN(mime, ";", 2)[0]))
	if mime == "image/jpg" {
		mime = "image/jpeg"
	}
	if len(data) == 0 || len(data) > 64<<20 || sniffed == "" || sniffed != mime {
		return DeliveredImage{}, downloadFailure(errors.New("invalid original"))
	}
	if err := ctx.Err(); err != nil {
		return DeliveredImage{}, err
	}
	sourceBytes := int64(len(data))
	sourceURL := in.SourceURL
	insert := domain.GalleryInsert{OutputKey: fmt.Sprintf("%s:%d:%d", in.RequestID, in.SubrequestIndex, in.ImageIndex), RequestID: in.RequestID, Model: in.Model, Prompt: in.Prompt, SizeRequest: in.ExpectedSize, AccountName: in.AccountName, SourceURL: &sourceURL, SourceMIME: &mime, SourceBytes: &sourceBytes, Image: data, ImageMIME: &mime}
	if in.AccountID > 0 {
		insert.AccountID = &in.AccountID
	}
	if in.Measurement.Size != nil {
		actual := images.FormatPixel(*in.Measurement.Size)
		insert.SizeActual = &actual
	}
	if d.store == nil {
		return DeliveredImage{}, persistFailure()
	}
	stored, original, err := d.store.SaveDeliveryImage(ctx, insert, in.IncludeBase64)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return DeliveredImage{}, err
		}
		return DeliveredImage{}, persistFailure()
	}
	result := DeliveredImage{Stored: stored, SourceURL: in.SourceURL, Measurement: in.Measurement}
	if in.IncludeBase64 {
		encoded := base64.StdEncoding.EncodeToString(original)
		result.Base64 = &encoded
	}
	return result, nil
}
func retryableDownload(err error) bool {
	var classified *images.DownloadError
	if errors.As(err, &classified) {
		return classified.Retryable
	}
	var network net.Error
	return errors.As(err, &network) && (network.Timeout() || network.Temporary())
}
func downloadFailure(err error) error {
	var network net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &network) && network.Timeout()) {
		return apierror.Coded(504, "image download timed out", "server_error", "image_download_timeout")
	}
	return apierror.Coded(502, "image download failed", "server_error", "image_download_failed")
}
func persistFailure() error {
	return apierror.Coded(503, "image could not be saved", "server_error", "image_persist_failed")
}
