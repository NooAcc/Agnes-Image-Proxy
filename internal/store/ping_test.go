package store_test

import (
	"context"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func TestPingReportsConnectivityAndClosedStore(t *testing.T) {
	db := testutil.OpenDB(t)
	st := store.New(db, nil)

	if err := st.Ping(context.Background()); err != nil {
		t.Fatalf("Ping on open store: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := st.Ping(context.Background()); err == nil {
		t.Fatal("Ping after Close succeeded, want error")
	}
}
