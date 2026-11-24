package agnes

import (
	"context"
	"errors"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

// AccountRepository is the storage boundary the pool needs.
type AccountRepository interface {
	Claim(ctx context.Context, exclude []int64) (*domain.ClaimedAccount, error)
	RecordSuccess(ctx context.Context, id int64, expectedFailCount int64, images int) error
	RecordFailure(ctx context.Context, id int64, cooldown time.Duration) error
}

// Generation is the outcome of one client sub-request.
type Generation struct {
	Images      []domain.OutputImage
	AccountID   int64
	AccountName string
	Attempts    []domain.Attempt
}

// Pool schedules attempts across the account pool.
type Pool struct {
	accounts AccountRepository
	client   Generator
	now      func() time.Time
}

// NewPool builds a pool over the shared account repository.
func NewPool(accounts AccountRepository, client Generator, now func() time.Time) *Pool {
	if now == nil {
		now = time.Now
	}
	return &Pool{accounts: accounts, client: client, now: now}
}

// Generate runs one sub-request with per-attempt exclusion and failure
// classification.
func (p *Pool) Generate(ctx context.Context, req domain.ImageRequest, settings domain.Settings) (Generation, error) {
	result := Generation{Attempts: []domain.Attempt{}}

	payload, err := images.Payload(req, settings.ImageParamMode)
	if err != nil {
		return result, err
	}

	maxAttempts := settings.MaxAttempts
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	if maxAttempts > 10 {
		maxAttempts = 10
	}
	timeout := time.Duration(settings.RequestTimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 300 * time.Second
	}

	var failures []error
	var tried []int64

	for attemptIndex := 0; attemptIndex < maxAttempts; attemptIndex++ {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		account, err := p.accounts.Claim(ctx, tried)
		if err != nil {
			return result, err
		}
		if account == nil {
			if attemptIndex == 0 {
				return result, apierror.Coded(503, "no upstream account available", "server_error", "no_account")
			}
			failures = append(failures, &Failure{Status: 503, Code: "no_account", Message: "no upstream account available"})
			break
		}
		tried = append(tried, account.ID)

		started := p.now()
		attempt := domain.Attempt{Index: attemptIndex, AccountID: account.ID, AccountName: account.Name}
		raw, genErr := p.client.Generate(ctx, settings.AgnesBaseURL, account.APIKey, payload, timeout)
		if genErr == nil {
			output, normErr := images.Normalize(raw)
			if normErr == nil {
				attempt.Status = 200
				attempt.DurationMS = p.now().Sub(started).Milliseconds()
				result.Attempts = append(result.Attempts, attempt)
				p.recordSuccess(ctx, account, len(output))
				result.Images = output
				result.AccountID = account.ID
				result.AccountName = account.Name
				return result, nil
			}
			genErr = &HTTPError{Status: 502, Code: "invalid_upstream_response", Message: "upstream response is invalid"}
		}

		attempt.DurationMS = p.now().Sub(started).Milliseconds()
		if ctx.Err() != nil {
			attempt.Status = 499
			attempt.Code = "canceled"
			attempt.Message = "client canceled"
			result.Attempts = append(result.Attempts, attempt)
			return result, ctx.Err()
		}

		classified := classifyFailure(genErr, account.FailCount)
		attempt.Status = classified.displayStatus
		attempt.Code = classified.displayCode
		attempt.Message = classified.displayMessage
		result.Attempts = append(result.Attempts, attempt)

		if !classified.retryable {
			return result, clientError(genErr)
		}
		failures = append(failures, classified.failure)
		p.recordFailure(ctx, account.ID, classified.cooldown)
	}

	return result, SelectFailure(failures, p.now())
}

type classification struct {
	failure        *Failure
	cooldown       time.Duration
	retryable      bool
	displayStatus  int
	displayCode    string
	displayMessage string
}

func classifyFailure(err error, failCount int64) classification {
	backoff := failureBackoff(failCount)

	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		switch {
		case httpErr.Status == 400 || httpErr.Status == 404:
			return classification{
				retryable:      false,
				displayStatus:  httpErr.Status,
				displayCode:    httpErr.Code,
				displayMessage: httpErr.Message,
			}
		case httpErr.Status == 401 || httpErr.Status == 403:
			return classification{
				failure:        &Failure{Status: 502, Code: "upstream_auth_failed", Message: "upstream rejected the account", Err: err},
				cooldown:       15 * time.Minute,
				retryable:      true,
				displayStatus:  httpErr.Status,
				displayCode:    httpErr.Code,
				displayMessage: httpErr.Message,
			}
		case httpErr.Status == 429:
			delay := httpErr.RetryAfter
			if delay <= 0 {
				delay = 60 * time.Second
			}
			if delay > 900*time.Second {
				delay = 900 * time.Second
			}
			return classification{
				failure:        &Failure{Status: 429, Code: "upstream_rate_limited", Message: httpErr.Message, RetryAfter: delay, Err: err},
				cooldown:       delay,
				retryable:      true,
				displayStatus:  429,
				displayCode:    httpErr.Code,
				displayMessage: httpErr.Message,
			}
		default:
			return classification{
				failure:        &Failure{Status: 502, Code: "upstream_error", Message: httpErr.Message, Err: err},
				cooldown:       backoff,
				retryable:      true,
				displayStatus:  httpErr.Status,
				displayCode:    httpErr.Code,
				displayMessage: httpErr.Message,
			}
		}
	}

	if errors.Is(err, context.DeadlineExceeded) {
		return classification{
			failure:        &Failure{Status: 504, Code: "upstream_timeout", Message: "upstream request timed out", Err: err},
			cooldown:       backoff,
			retryable:      true,
			displayStatus:  504,
			displayCode:    "upstream_timeout",
			displayMessage: "upstream request timed out",
		}
	}

	message := "upstream transport error"
	if err != nil {
		message = err.Error()
		if len(message) > 300 {
			message = message[:300]
		}
	}
	return classification{
		failure:        &Failure{Status: 502, Code: "upstream_transport", Message: message, Err: err},
		cooldown:       backoff,
		retryable:      true,
		displayStatus:  502,
		displayCode:    "upstream_transport",
		displayMessage: message,
	}
}

func failureBackoff(failCount int64) time.Duration {
	exponent := failCount
	if exponent < 0 {
		exponent = 0
	}
	if exponent > 8 {
		exponent = 8
	}
	delay := 60 * time.Second
	for i := int64(0); i < exponent; i++ {
		delay *= 2
		if delay >= 900*time.Second {
			return 900 * time.Second
		}
	}
	if delay > 900*time.Second {
		return 900 * time.Second
	}
	return delay
}

func clientError(err error) error {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		status := httpErr.Status
		if status < 400 || status > 499 {
			status = 502
		}
		apiErr := apierror.New(status, httpErr.Message, "invalid_request_error")
		if httpErr.Code != "" {
			code := httpErr.Code
			apiErr.Code = &code
		}
		return apiErr
	}
	return apierror.Coded(502, "upstream request failed", "server_error", "upstream_error")
}

func (p *Pool) recordSuccess(ctx context.Context, account *domain.ClaimedAccount, images int) {
	recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = p.accounts.RecordSuccess(recordCtx, account.ID, account.FailCount, images)
}

func (p *Pool) recordFailure(ctx context.Context, id int64, cooldown time.Duration) {
	recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = p.accounts.RecordFailure(recordCtx, id, cooldown)
}
