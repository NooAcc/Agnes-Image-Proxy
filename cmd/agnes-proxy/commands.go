// Command agnes-proxy serves the proxy and admin console, or runs the offline
// preview, health check and destructive reset helpers.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/app"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/config"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/preview"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/webassets"
)

const (
	defaultPreviewPort = 8001
	healthcheckTimeout = 5 * time.Second
	dbOpenTimeout      = 15 * time.Second
)

// Run dispatches a subcommand. It returns an error instead of exiting so tests
// can exercise every path; main turns a non-nil error into exit code 1.
func Run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		args = []string{"serve"}
	}
	switch args[0] {
	case "serve":
		return runServe(ctx, args[1:], getenv, stdout, stderr)
	case "preview":
		return runPreview(ctx, args[1:], stdout, stderr)
	case "healthcheck":
		return runHealthcheck(ctx, args[1:], stdout, stderr)
	case "reset-db":
		return runResetDB(ctx, args[1:], getenv, stdout, stderr)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func newLogger(stderr io.Writer) *log.Logger {
	return log.New(stderr, "", log.LstdFlags)
}

func runServe(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	if err := flags.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	assets, err := webassets.FS()
	if err != nil {
		return err
	}
	logger := newLogger(stderr)
	db, err := store.Open(ctx, store.Options{
		URL:       cfg.TursoDatabaseURL,
		AuthToken: cfg.TursoAuthToken,
		Timeout:   dbOpenTimeout,
		DataDir:   cfg.DataDir,
	})
	if err != nil {
		return err
	}
	runtime, err := app.NewRuntime(app.Options{
		Store:              db,
		Assets:             assets,
		APIKey:             cfg.ProxyAPIKey,
		CORSAllowedOrigins: cfg.CORSAllowedOrigins,
		TrustedProxies:     cfg.TrustedProxyCIDRs,
		MaxInFlight:        cfg.MaxInFlight,
		ArchiveWorkers:     cfg.ArchiveWorkers,
		ArchiveCapacity:    cfg.ArchiveCapacity,
		Logf:               logger.Printf,
	})
	if err != nil {
		_ = db.Close()
		return err
	}

	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           runtime.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()
	fmt.Fprintf(stdout, "agnes-proxy listening on :%d\n", cfg.Port)

	select {
	case <-ctx.Done():
		budget, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		runtime.StopAdmission()
		serverErr := server.Shutdown(budget)
		runtimeErr := runtime.Shutdown(budget)
		return errors.Join(serverErr, runtimeErr)
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		budget, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = runtime.Shutdown(budget)
		return err
	}
}

func runPreview(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("preview", flag.ContinueOnError)
	flags.SetOutput(stderr)
	port := flags.Int("port", defaultPreviewPort, "loopback port (0 picks an ephemeral port)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	assets, err := webassets.FS()
	if err != nil {
		return err
	}
	logger := newLogger(stderr)
	instance, err := preview.New(preview.Options{Port: *port, Assets: assets, Logf: logger.Printf})
	if err != nil {
		return err
	}
	defer func() { _ = instance.Close() }()

	fmt.Fprintf(stdout, "preview ready at %s/admin (admin API key: %s)\n", instance.URL, preview.AdminAPIKey)
	return instance.Serve(ctx)
}

func runHealthcheck(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	flags.SetOutput(stderr)
	url := flags.String("url", "", "health endpoint, for example http://127.0.0.1:8000/health")
	timeout := flags.Duration("timeout", healthcheckTimeout, "request timeout")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*url) == "" {
		return errors.New("healthcheck: --url is required")
	}

	checkCtx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(checkCtx, http.MethodGet, *url, nil)
	if err != nil {
		return fmt.Errorf("healthcheck: %w", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("healthcheck: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("healthcheck: status %d", response.StatusCode)
	}
	_, _ = fmt.Fprintln(stdout, "ok")
	return nil
}

func runResetDB(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("reset-db", flag.ContinueOnError)
	flags.SetOutput(stderr)
	confirm := flags.Bool("confirm", false, "required: deletes all application tables, local image files and every registered ImgBed original; stop serve first")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !*confirm {
		return errors.New("reset-db deletes all application tables, local image files and every registered ImgBed original; stop serve first, then pass --confirm (no database or image directory was opened)")
	}

	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	db, err := store.Open(ctx, store.Options{
		URL:       cfg.TursoDatabaseURL,
		AuthToken: cfg.TursoAuthToken,
		Timeout:   dbOpenTimeout,
		DataDir:   cfg.DataDir,
	})
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	if err := db.ResetSchema(ctx, true); err != nil {
		return fmt.Errorf("reset-db failed; storage credentials and remaining rows were kept: %w", err)
	}
	_, _ = fmt.Fprintln(stdout, "database rebuilt and local application image files cleared; registered ImgBed originals were removed (orphaned or unregistered remote files are not tracked)")
	return nil
}
