package store

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func TestDataDirHint(t *testing.T) {
	permission := &os.PathError{Op: "mkdirat", Path: "images", Err: os.ErrPermission}
	hinted := dataDirHint(permission)
	if !strings.Contains(hinted.Error(), "uid 65532") {
		t.Fatalf("permission error %q does not name the container user", hinted)
	}
	if !errors.Is(hinted, os.ErrPermission) {
		t.Fatal("hinted error lost the permission cause")
	}

	plain := errors.New("boom")
	if got := dataDirHint(plain); got != plain {
		t.Fatalf("non-permission error changed: %v", got)
	}
}
