// Package app assembles the store, background services and HTTP router into a
// single runtime. It exists outside internal/service because the router
// depends on the service package, so the assembly cannot live there.
package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/auth"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/httpapi"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/store"
)

const (
	defaultMaxInFlight     = 8
	defaultArchiveWorkers  = 4
	defaultArchiveCapacity = 32
	schemaTimeout          = 30 * time.Second
)

// Options wires the runtime. Store ownership transfers to the runtime.
type Options struct {
	// Context is the lifetime of background work. It defaults to
	// context.Background and is canceled by Shutdown; it must not be the
	// signal context, or admitted enrichment would be canceled before draining.
	Context            context.Context
	Store              *store.Store
	Assets             fs.FS
	APIKey             string
	CORSAllowedOrigins []string
	TrustedProxies     []*net.IPNet
	PublicOrigin       string
	MaxInFlight        int
	ArchiveWorkers     int
	ArchiveCapacity    int
	ProbeTimeout       time.Duration
	Downloader         service.Downloader
	HTTPClient         *http.Client
	Now                func() time.Time
	Logf               func(format string, args ...any)
}

// Runtime owns every long-lived dependency and closes them in order.
type Runtime struct {
	store    *store.Store
	tasks    *service.Tasks
	backfill *service.Backfill
	handler  http.Handler
	cancel   context.CancelFunc
	logf     func(string, ...any)

	closeOnce sync.Once
	closeErr  error
}

// NewRuntime builds the schema, services and router. On failure it does not
// close the caller's store; the caller still owns it.
func NewRuntime(options Options) (*Runtime, error) {
	if options.Store == nil {
		return nil, errors.New("runtime: store is required")
	}
	if strings.TrimSpace(options.APIKey) == "" {
		return nil, errors.New("runtime: API key is required")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	logf := options.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	lifetime := options.Context
	if lifetime == nil {
		lifetime = context.Background()
	}
	runtimeCtx, cancel := context.WithCancel(lifetime)

	schemaCtx, schemaCancel := context.WithTimeout(runtimeCtx, schemaTimeout)
	defer schemaCancel()
	if err := options.Store.EnsureSchema(schemaCtx); err != nil {
		cancel()
		return nil, err
	}

	maxInFlight := options.MaxInFlight
	if maxInFlight < 1 {
		maxInFlight = defaultMaxInFlight
	}
	archiveWorkers := options.ArchiveWorkers
	if archiveWorkers < 1 {
		archiveWorkers = defaultArchiveWorkers
	}
	archiveCapacity := options.ArchiveCapacity
	if archiveCapacity < archiveWorkers {
		archiveCapacity = defaultArchiveCapacity
	}

	remote := images.NewRemote(images.RemoteOptions{})
	downloader := options.Downloader
	if downloader == nil {
		downloader = remote
	}
	locks := service.NewGalleryLocks()
	pool := agnes.NewPool(options.Store, agnes.NewClient(options.HTTPClient), now)
	edge := service.NewEdge(options.HTTPClient).WithEnrichmentWriter(options.Store).WithOriginalReader(options.Store)
	tasks := service.NewTasks(service.TaskOptions{
		Workers:  archiveWorkers,
		Capacity: archiveCapacity,
		Context:  runtimeCtx,
		OnPanic: func(recovered any) {
			logf("panic in background task: %v", recovered)
		},
	})
	delivery := service.NewDelivery(service.DeliveryOptions{Store: options.Store, Downloader: downloader})
	enrichment := service.NewEnrichmentJobs(service.EnrichmentJobOptions{Store: options.Store, Enricher: edge, Locks: locks, Now: now, Logf: logf})
	orchestrator := service.NewImages(service.ImageOptions{
		Pool:         pool,
		Edge:         edge,
		Tasks:        tasks,
		Delivery:     delivery,
		Enrichment:   enrichment,
		Measurements: options.Store,
		Logs:         options.Store,
		Context:      runtimeCtx,
		MaxInFlight:  maxInFlight,
		Now:          now,
		Logf:         logf,
	})
	backfill := service.NewBackfill(service.BackfillOptions{
		Store:    options.Store,
		Enricher: edge,
		Settings: options.Store.ReadSettings,
		Locks:    locks,
	})
	probe := service.NewProbe(service.ProbeOptions{
		Store:        options.Store,
		Prober:       agnes.NewClient(options.HTTPClient),
		ProbeTimeout: options.ProbeTimeout,
	})

	sessions := auth.NewSessions(options.APIKey, options.Store, now)
	limiter := auth.NewLimiter(now)
	authz := httpapi.NewAuth(httpapi.AuthOptions{
		APIKey:         options.APIKey,
		Sessions:       sessions,
		Limiter:        limiter,
		AllowedOrigins: options.CORSAllowedOrigins,
		TrustedProxies: options.TrustedProxies,
		PublicOrigin:   options.PublicOrigin,
		Now:            now,
	})
	var assets http.Handler
	if options.Assets != nil {
		assets = httpapi.NewAssets(options.Assets)
	}
	handler := httpapi.New(httpapi.Options{
		Auth:         authz,
		ImageLinks:   auth.NewImageLinks(options.APIKey, now),
		PublicImages: options.Store,
		Images:       orchestrator,
		Store:        options.Store,
		Storage:      options.Store,
		Backfill:     backfill,
		Probe:        probe,
		Settings:     options.Store.ReadSettings,
		Reference:    remote,
		Logs:         options.Store,
		Assets:       assets,
		DeepCheck:    options.Store.Ping,
	})

	return &Runtime{
		store:    options.Store,
		tasks:    tasks,
		backfill: backfill,
		handler:  handler,
		cancel:   cancel,
		logf:     logf,
	}, nil
}

// Handler returns the application router.
func (r *Runtime) Handler() http.Handler { return r.handler }

// StopAdmission rejects new reservations while admitted work may still submit.
func (r *Runtime) StopAdmission() { r.tasks.StopAdmission() }

// Shutdown stops admission, stops the backfill, drains delivery reservations and enrichment,
// then closes the database. If the budget expires, running work is canceled and
// the unfinished count is logged; no stronger guarantee is claimed.
func (r *Runtime) Shutdown(ctx context.Context) error {
	r.closeOnce.Do(func() {
		r.closeErr = r.shutdown(ctx)
	})
	return r.closeErr
}

func (r *Runtime) shutdown(ctx context.Context) error {
	r.StopAdmission()
	var errs []error
	if err := r.backfill.Stop(ctx); err != nil {
		errs = append(errs, fmt.Errorf("stop enrichment: %w", err))
	}
	if err := r.tasks.Drain(ctx); err != nil {
		r.logf("shutdown: %d task(s) unfinished after %v", r.tasks.Pending(), err)
		errs = append(errs, err)
	}
	r.cancel()
	if err := r.store.Close(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
