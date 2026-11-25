package httpapi_test

import (
	"context"
	"strings"
	"testing"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/testutil"
)

func TestAdminGenerationUninitialized(t *testing.T) {
	st, err := store.New(testutil.OpenDB(t), store.NewOptions{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.EnsureSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	handler := httpapi.New(httpapi.Options{
		Auth:  httpapi.NewAuth(httpapi.AuthOptions{APIKey: "secret-key"}),
		Store: st, Storage: st,
	})
	rec := callHandler(handler, generationReq("POST", "/admin/api/images/generations", `{}`, "", "", "secret-key"))
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), "initialization_required") {
		t.Fatalf("uninitialized=%d %s", rec.Code, rec.Body.String())
	}
}
