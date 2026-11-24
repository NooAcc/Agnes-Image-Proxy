package agnes

import (
	"errors"
	"strconv"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
)

// Failure is a classified, retryable upstream failure.
type Failure struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
	Err        error
}

func (f *Failure) Error() string {
	if f.Message != "" {
		return f.Message
	}
	if f.Err != nil {
		return f.Err.Error()
	}
	return "upstream request failed"
}

func (f *Failure) Unwrap() error { return f.Err }

// HTTPStatus exposes the aggregated status for SelectFailure.
func (f *Failure) HTTPStatus() int { return f.Status }

// SelectFailure aggregates attempt failures with the fixed priority
// 429 > 504 > 502 > 503.
func SelectFailure(errs []error, _ time.Time) error {
	present := make(map[int]bool)
	var retryAfter time.Duration
	for _, err := range errs {
		status, delay, ok := failureStatus(err)
		if !ok {
			continue
		}
		present[status] = true
		if status == 429 && delay > 0 {
			if retryAfter == 0 || delay < retryAfter {
				retryAfter = delay
			}
		}
	}

	switch {
	case present[429]:
		if retryAfter <= 0 {
			retryAfter = 60 * time.Second
		}
		if retryAfter > 900*time.Second {
			retryAfter = 900 * time.Second
		}
		seconds := int(retryAfter / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		return apierror.Coded(429, "upstream rate limited", "server_error", "upstream_rate_limited").
			WithHeader("Retry-After", strconv.Itoa(seconds))
	case present[504]:
		return apierror.Coded(504, "upstream request timed out", "server_error", "upstream_timeout")
	case present[502]:
		return apierror.Coded(502, "upstream request failed", "server_error", "upstream_error")
	case present[503]:
		return apierror.Coded(503, "no upstream account available", "server_error", "no_account")
	default:
		return apierror.Coded(502, "upstream request failed", "server_error", "upstream_error")
	}
}

func failureStatus(err error) (int, time.Duration, bool) {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure.Status, failure.RetryAfter, true
	}
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		if httpErr.Status == 429 {
			return 429, httpErr.RetryAfter, true
		}
		return 502, 0, true
	}
	// Sub-request failures arriving from Pool.Generate are already aggregated
	// apierrors; keep their class when several client sub-requests failed.
	var apiErr *apierror.Error
	if errors.As(err, &apiErr) {
		switch apiErr.Status {
		case 429:
			return 429, retryAfterHeader(apiErr), true
		case 504, 502, 503:
			return apiErr.Status, 0, true
		}
	}
	return 0, 0, false
}

func retryAfterHeader(apiErr *apierror.Error) time.Duration {
	if apiErr.Headers == nil {
		return 0
	}
	seconds, err := strconv.Atoi(apiErr.Headers.Get("Retry-After"))
	if err != nil || seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}
