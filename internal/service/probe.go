package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const defaultProbeTimeout = 15 * time.Second

// Prober performs one non-generating availability check.
type Prober interface {
	ProbeModels(ctx context.Context, baseURL, apiKey string, timeout time.Duration) error
}

// ProbeStore is the persistence boundary for account probes.
type ProbeStore interface {
	ListAccounts(ctx context.Context) ([]domain.AccountSummary, error)
	GetAccount(ctx context.Context, id int64) (domain.Account, error)
	RecordFailure(ctx context.Context, id int64, cooldown time.Duration) error
}

// ProbeOptions wires the account prober.
type ProbeOptions struct {
	Store        ProbeStore
	Prober       Prober
	ProbeTimeout time.Duration
}

// ProbeResult is the admin-facing probe outcome; it never carries the key.
type ProbeResult struct {
	ID      int64  `json:"id"`
	OK      bool   `json:"ok"`
	Status  int    `json:"status"`
	Message string `json:"message"`
}

// Probe checks upstream account availability without generating images.
type Probe struct {
	store   ProbeStore
	prober  Prober
	timeout time.Duration
}

// NewProbe builds the prober.
func NewProbe(options ProbeOptions) *Probe {
	timeout := options.ProbeTimeout
	if timeout <= 0 {
		timeout = defaultProbeTimeout
	}
	return &Probe{store: options.Store, prober: options.Prober, timeout: timeout}
}

// One probes a single account; upstream rejection is a result, not an error.
func (p *Probe) One(ctx context.Context, id int64, settings domain.Settings) (ProbeResult, error) {
	account, err := p.store.GetAccount(ctx, id)
	if err != nil {
		return ProbeResult{}, err
	}
	return p.probe(ctx, account.ID, account.APIKey, settings), nil
}

// All probes every account with settings.ProbeConcurrency workers.
func (p *Probe) All(ctx context.Context, settings domain.Settings) ([]ProbeResult, error) {
	accounts, err := p.store.ListAccounts(ctx)
	if err != nil {
		return nil, err
	}
	results := make([]ProbeResult, len(accounts))
	concurrency := settings.ProbeConcurrency
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > 10 {
		concurrency = 10
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	jobs := make(chan int)
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		firstErr error
	)
	for worker := 0; worker < concurrency; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				result, err := p.One(ctx, accounts[index].ID, settings)
				if err != nil {
					if ctx.Err() == nil {
						mu.Lock()
						if firstErr == nil {
							firstErr = err
						}
						mu.Unlock()
					}
					continue
				}
				results[index] = result
			}
		}()
	}
	for index := range accounts {
		select {
		case jobs <- index:
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			return nil, ctx.Err()
		}
	}
	close(jobs)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if firstErr != nil {
		return nil, firstErr
	}
	return results, nil
}

func (p *Probe) probe(ctx context.Context, id int64, apiKey string, settings domain.Settings) ProbeResult {
	if p.prober == nil {
		return ProbeResult{ID: id, OK: false, Status: 503, Message: "probe is unavailable"}
	}
	err := p.prober.ProbeModels(ctx, settings.AgnesBaseURL, apiKey, p.timeout)
	if err == nil {
		return ProbeResult{ID: id, OK: true, Status: 200, Message: "ok"}
	}
	if ctx.Err() != nil {
		return ProbeResult{ID: id, OK: false, Status: 499, Message: "canceled"}
	}

	result := ProbeResult{ID: id, OK: false, Status: 502, Message: sanitizeProbeMessage(err, apiKey)}
	var httpErr *agnes.HTTPError
	if errors.As(err, &httpErr) {
		result.Status = httpErr.Status
	}
	cooldown := probeCooldown(err)
	_ = p.store.RecordFailure(context.WithoutCancel(ctx), id, cooldown)
	return result
}

func probeCooldown(err error) time.Duration {
	var httpErr *agnes.HTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.Status {
		case 401, 403:
			return 15 * time.Minute
		case 429:
			if httpErr.RetryAfter > 0 {
				if httpErr.RetryAfter > 900*time.Second {
					return 900 * time.Second
				}
				return httpErr.RetryAfter
			}
		}
	}
	return 60 * time.Second
}

func sanitizeProbeMessage(err error, apiKey string) string {
	message := err.Error()
	if apiKey != "" {
		message = strings.ReplaceAll(message, apiKey, "[redacted]")
	}
	message = strings.TrimSpace(message)
	if len(message) > 300 {
		message = message[:300]
	}
	if message == "" {
		message = "probe failed"
	}
	return message
}
