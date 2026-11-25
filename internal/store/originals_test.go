package store

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

func TestLocalOriginalBackendLifecycle(t *testing.T) {
	s, _ := localGallery(t)
	backend := localBackend{files: s.files}
	ctx := context.Background()
	id := "0123456789abcdef0123456789abcdef"
	data := []byte("local-original-bytes")

	ref, verified, err := backend.Write(ctx, id, "image/png", data)
	if err != nil || !bytes.Equal(verified, data) {
		t.Fatalf("write: %q %v", ref, err)
	}
	if ref != "01/"+id+"/original.png" {
		t.Fatalf("ref = %q", ref)
	}
	got, err := backend.Read(ctx, ref, "image/png", int64(len(data)))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("read: %v", err)
	}
	if err := backend.Verify(ctx, ref, "image/png", int64(len(data))); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if _, err := backend.Read(ctx, ref, "image/jpeg", int64(len(data))); err == nil {
		t.Fatal("MIME/ref identity mismatch accepted")
	}
	if err := backend.Verify(ctx, ref, "image/png", int64(len(data))+1); err == nil {
		t.Fatal("length mismatch accepted")
	}
	if err := backend.Delete(ctx, ref); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := backend.Read(ctx, ref, "image/png", int64(len(data))); err == nil {
		t.Fatal("deleted original still readable")
	} else {
		var apiErr *apierror.Error
		if !errors.As(err, &apiErr) || apiErr.Status != 404 {
			t.Fatalf("missing local original = %v", err)
		}
	}
	if err := backend.Delete(ctx, "not/a/ref"); err == nil {
		t.Fatal("unsafe delete ref accepted")
	}
}
