package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func envFrom(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func validEnv() map[string]string {
	return map[string]string{
		"PROXY_API_KEY":      "test-proxy-key",
		"TURSO_DATABASE_URL": "http://93.184.216.34",
		"TURSO_AUTH_TOKEN":   "test-token",
	}
}

func TestRunServeRequiresEnvironmentAndNeverFallsBackToPreview(t *testing.T) {
	var stdout bytes.Buffer
	err := Run(context.Background(), nil, envFrom(nil), &stdout, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "PROXY_API_KEY") {
		t.Fatalf("serve without env = %v, want PROXY_API_KEY error", err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("serve wrote %q before failing; preview must not be started", stdout.String())
	}

	stdout.Reset()
	err = Run(context.Background(), []string{"serve"}, envFrom(map[string]string{"PROXY_API_KEY": "k"}), &stdout, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "TURSO_DATABASE_URL") {
		t.Fatalf("serve with partial env = %v, want TURSO_DATABASE_URL error", err)
	}
}

func TestRunServeOpensTheConfiguredDatabaseOnly(t *testing.T) {
	env := validEnv()
	var stdout bytes.Buffer
	err := Run(context.Background(), []string{"serve"}, envFrom(env), &stdout, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "invalid database URL") {
		t.Fatalf("serve with invalid database URL = %v, want database validation error", err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("serve listened despite database failure: %q", stdout.String())
	}
}

func TestRunHealthcheck(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer healthy.Close()
	var stdout bytes.Buffer
	if err := Run(context.Background(), []string{"healthcheck", "--url", healthy.URL}, envFrom(nil), &stdout, io.Discard); err != nil {
		t.Fatalf("healthy check: %v", err)
	}
	if strings.TrimSpace(stdout.String()) != "ok" {
		t.Fatalf("healthy check stdout = %q", stdout.String())
	}

	unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer unhealthy.Close()
	if err := Run(context.Background(), []string{"healthcheck", "--url", unhealthy.URL}, envFrom(nil), io.Discard, io.Discard); err == nil ||
		!strings.Contains(err.Error(), "status 500") {
		t.Fatalf("unhealthy check = %v, want status error", err)
	}

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer slow.Close()
	if err := Run(context.Background(), []string{"healthcheck", "--url", slow.URL, "--timeout", "20ms"}, envFrom(nil), io.Discard, io.Discard); err == nil {
		t.Fatal("slow healthcheck succeeded, want timeout error")
	}

	if err := Run(context.Background(), []string{"healthcheck"}, envFrom(nil), io.Discard, io.Discard); err == nil ||
		!strings.Contains(err.Error(), "--url") {
		t.Fatalf("healthcheck without url = %v, want --url error", err)
	}
}

func TestRunResetDBRequiresConfirmationBeforeOpeningTheDatabase(t *testing.T) {
	env := validEnv()
	start := time.Now()
	err := Run(context.Background(), []string{"reset-db"}, envFrom(env), io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "--confirm") {
		t.Fatalf("reset-db without --confirm = %v, want confirmation error", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("reset-db without --confirm took %v; it must fail before connecting", elapsed)
	}

	// With confirmation the command proceeds to open the database, so the
	// database URL error (not the confirmation error) is returned.
	err = Run(context.Background(), []string{"reset-db", "--confirm"}, envFrom(env), io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "invalid database URL") {
		t.Fatalf("reset-db --confirm = %v, want database URL error", err)
	}
}

func TestRunPreviewNeedsNoEnvironment(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var stdout bytes.Buffer
	if err := Run(ctx, []string{"preview", "--port", "0"}, envFrom(nil), &stdout, io.Discard); err != nil {
		t.Fatalf("preview: %v", err)
	}
	output := stdout.String()
	if !strings.Contains(output, "preview ready at http://127.0.0.1:") {
		t.Fatalf("preview stdout = %q, want loopback URL", output)
	}
	if !strings.Contains(output, "admin API key: preview") {
		t.Fatalf("preview stdout = %q, want the mock key only", output)
	}
}

func TestRunUnknownCommand(t *testing.T) {
	err := Run(context.Background(), []string{"nope"}, envFrom(nil), io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Fatalf("unknown command = %v", err)
	}
}
