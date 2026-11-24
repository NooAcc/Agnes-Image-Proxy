package agnes_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/agnes"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/images"
)

type apierrorError = apierror.Error

var fixedNow = func() time.Time {
	return time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
}

type recordedFailure struct {
	id       int64
	cooldown time.Duration
}

type recordedSuccess struct {
	id                int64
	expectedFailCount int64
	images            int
}

type fakeRepo struct {
	accounts        []domain.ClaimedAccount
	claims          []int64
	claimExclusions [][]int64
	failures        []recordedFailure
	successes       []recordedSuccess
	claimErr        error
	failCount       int64
}

func newFakeRepo(ids ...int64) *fakeRepo {
	repo := &fakeRepo{}
	for _, id := range ids {
		repo.accounts = append(repo.accounts, domain.ClaimedAccount{
			ID:     id,
			Name:   "account-" + strconv.FormatInt(id, 10),
			APIKey: "key-" + strconv.FormatInt(id, 10) + "-abcdefghij",
		})
	}
	return repo
}

func (f *fakeRepo) Claim(_ context.Context, exclude []int64) (*domain.ClaimedAccount, error) {
	copied := append([]int64(nil), exclude...)
	f.claimExclusions = append(f.claimExclusions, copied)
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	for _, account := range f.accounts {
		excluded := false
		for _, id := range exclude {
			if id == account.ID {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		f.claims = append(f.claims, account.ID)
		account.FailCount = f.failCount
		return &account, nil
	}
	return nil, nil
}

func (f *fakeRepo) RecordSuccess(_ context.Context, id int64, expectedFailCount int64, amount int) error {
	f.successes = append(f.successes, recordedSuccess{id: id, expectedFailCount: expectedFailCount, images: amount})
	return nil
}

func (f *fakeRepo) RecordFailure(_ context.Context, id int64, cooldown time.Duration) error {
	f.failures = append(f.failures, recordedFailure{id: id, cooldown: cooldown})
	return nil
}

type fakeResponse struct {
	raw json.RawMessage
	err error
}

type generatorCall struct {
	baseURL string
	key     string
	payload map[string]any
	timeout time.Duration
}

type fakeGenerator struct {
	responses map[int64]fakeResponse
	calls     []generatorCall
	onCall    func()
}

func (f *fakeGenerator) Generate(_ context.Context, baseURL, key string, payload map[string]any, timeout time.Duration) (json.RawMessage, error) {
	if f.onCall != nil {
		f.onCall()
	}
	f.calls = append(f.calls, generatorCall{baseURL: baseURL, key: key, payload: payload, timeout: timeout})
	response := f.responses[accountIDFromKey(key)]
	return response.raw, response.err
}

func accountIDFromKey(key string) int64 {
	parts := strings.Split(key, "-")
	if len(parts) < 2 {
		return 0
	}
	id, _ := strconv.ParseInt(parts[1], 10, 64)
	return id
}

func sampleRequest(t *testing.T) domain.ImageRequest {
	t.Helper()
	size, err := images.ResolveSize("1K", "", nil, "1K")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	return domain.ImageRequest{
		Endpoint:       "generations",
		Model:          "model",
		Prompt:         "prompt",
		N:              3,
		Size:           size,
		ResponseFormat: "url",
		ExtraBody:      map[string]json.RawMessage{},
	}
}

func testSettings() domain.Settings {
	settings := domain.DefaultSettings()
	settings.MaxAttempts = 3
	settings.RequestTimeoutMS = 5000
	return settings
}

func TestSelectFailurePriority(t *testing.T) {
	errs := []error{
		&agnes.Failure{Status: 503, Err: context.Canceled},
		&agnes.Failure{Status: 502},
		&agnes.Failure{Status: 504},
		&agnes.Failure{Status: 429, RetryAfter: 90 * time.Second},
	}
	err := agnes.SelectFailure(errs, fixedNow())
	var apiErr *apierror.Error
	if !apiErrAs(err, &apiErr) || apiErr.Status != 429 {
		t.Fatalf("status = %v", err)
	}
	if apiErr.Headers.Get("Retry-After") != "90" {
		t.Fatalf("retry-after = %q", apiErr.Headers.Get("Retry-After"))
	}
}

func TestSelectFailureShortestRetryAfter(t *testing.T) {
	errs := []error{
		&agnes.Failure{Status: 429, RetryAfter: 90 * time.Second},
		&agnes.HTTPError{Status: 429, RetryAfter: 30 * time.Second},
	}
	err := agnes.SelectFailure(errs, fixedNow())
	var apiErr *apierror.Error
	if !apiErrAs(err, &apiErr) || apiErr.Headers.Get("Retry-After") != "30" {
		t.Fatalf("error = %v", err)
	}
}

func TestSelectFailureCapsRetryAfter(t *testing.T) {
	err := agnes.SelectFailure([]error{&agnes.Failure{Status: 429, RetryAfter: 5000 * time.Second}}, fixedNow())
	var apiErr *apierror.Error
	if !apiErrAs(err, &apiErr) || apiErr.Headers.Get("Retry-After") != "900" {
		t.Fatalf("error = %v", err)
	}
}

func TestSelectFailureDefaults(t *testing.T) {
	cases := []struct {
		status int
		want   int
	}{
		{503, 503},
		{502, 502},
		{504, 504},
	}
	for _, tc := range cases {
		err := agnes.SelectFailure([]error{&agnes.Failure{Status: tc.status}}, fixedNow())
		var apiErr *apierror.Error
		if !apiErrAs(err, &apiErr) || apiErr.Status != tc.want {
			t.Fatalf("status %d -> %v", tc.status, err)
		}
	}
	if err := agnes.SelectFailure(nil, fixedNow()); err == nil {
		t.Fatal("empty failures should still produce an error")
	}
}

func apiErrAs(err error, target **apierror.Error) bool {
	for err != nil {
		if apiErr, ok := err.(*apierror.Error); ok {
			*target = apiErr
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}
