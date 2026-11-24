package store_test

import (
	"context"
	"testing"
)

func TestSessionEpochPersistence(t *testing.T) {
	s, _ := newSchemaStore(t)
	ctx := context.Background()

	epoch, err := s.SessionEpoch(ctx)
	if err != nil || epoch != 1 {
		t.Fatalf("initial epoch = %d, %v", epoch, err)
	}
	bumped, err := s.BumpSessionEpoch(ctx)
	if err != nil || bumped != 2 {
		t.Fatalf("bump = %d, %v", bumped, err)
	}
	epoch, err = s.SessionEpoch(ctx)
	if err != nil || epoch != 2 {
		t.Fatalf("epoch after bump = %d, %v", epoch, err)
	}
	again, err := s.BumpSessionEpoch(ctx)
	if err != nil || again != 3 {
		t.Fatalf("second bump = %d, %v", again, err)
	}
}
