package images_test

import (
	"context"
	"errors"
	"net"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

func TestRemoteDownloadDNSClassification(t *testing.T) {
	for _, tc := range []struct {
		name  string
		cause error
		retry bool
	}{
		{"temporary", &net.DNSError{Err: "temporary", IsTemporary: true}, true},
		{"timeout", &net.DNSError{Err: "timeout", IsTimeout: true}, true},
		{"not found", &net.DNSError{Err: "not found", IsNotFound: true}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			remote := images.NewRemote(images.RemoteOptions{Resolver: &staticResolver{err: tc.cause}})
			_, _, err := remote.Download(context.Background(), "https://images.example/image.png")
			var de *images.DownloadError
			if !errors.As(err, &de) || de.Retryable != tc.retry || !errors.Is(err, tc.cause) {
				t.Fatalf("DNS class discarded: %v", err)
			}
		})
	}
}
