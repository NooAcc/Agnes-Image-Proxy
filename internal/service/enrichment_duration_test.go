package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/service"
)

func TestEnrichmentJobLogDuration(t *testing.T) {
	for _, failures := range []int{0, 1, 2} {
		name := []string{"success", "partial", "failure"}[failures]
		t.Run(name, func(t *testing.T) {
			store := newFakeBackfillStore(map[int64]*fakeRow{
				1: {status: "pending", source: rowSource(1)},
				2: {status: "failed", source: rowSource(2)},
				3: {status: "success", source: rowSource(3)},
			})
			started := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
			now := started
			calls := 0
			failure := errors.New("enrichment failed")
			runner := service.NewEnrichmentJobs(service.EnrichmentJobOptions{
				Store: store,
				Now:   func() time.Time { return now },
				Enricher: enricherFunc(func(context.Context, []domain.GallerySource, domain.Settings) (service.EnrichReport, error) {
					calls++
					now = now.Add(125 * time.Millisecond)
					if calls <= failures {
						return service.EnrichReport{Processed: 1, Failed: 1}, failure
					}
					return service.EnrichReport{Processed: 1, Succeeded: 1}, nil
				}),
			})
			err := runner.Run(context.Background(), service.EnrichmentJob{
				RequestID: "duration", IDs: []int64{1, 2, 3, 4}, Settings: enabledSettings(),
			})
			if (failures == 0 && err != nil) || (failures > 0 && !errors.Is(err, failure)) {
				t.Fatalf("Run error = %v", err)
			}
			logs := store.snapshotLogs()
			if calls != 2 || len(logs) != 1 {
				t.Fatalf("calls = %d, logs = %+v", calls, logs)
			}
			log := logs[0]
			if log.DurationMS != 250 || !log.TS.Equal(now) || log.Stage != "enrichment" || log.Requested != 2 || log.Images != 2-failures || log.Failed != failures {
				t.Fatalf("log = %+v", log)
			}
		})
	}
}

func TestBackfillLogDuration(t *testing.T) {
	for _, failures := range []int{0, 1, 2} {
		name := []string{"success", "partial", "failure"}[failures]
		t.Run(name, func(t *testing.T) {
			store := newFakeBackfillStore(map[int64]*fakeRow{
				1: {status: "pending", source: rowSource(1)},
				2: {status: "failed", source: rowSource(2)},
			})
			const perImage = 20 * time.Millisecond
			calls := 0
			backfill := service.NewBackfill(service.BackfillOptions{
				Store: store, Settings: settingsFunc(enabledSettings()),
				Enricher: enricherFunc(func(context.Context, []domain.GallerySource, domain.Settings) (service.EnrichReport, error) {
					<-time.After(perImage)
					calls++
					if calls <= failures {
						return service.EnrichReport{Processed: 1, Failed: 1}, nil
					}
					return service.EnrichReport{Processed: 1, Succeeded: 1}, nil
				}),
			})
			if _, err := backfill.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			finished := waitBackfillDone(t, backfill)
			logs := store.snapshotLogs()
			if len(logs) != 1 {
				t.Fatalf("logs = %+v", logs)
			}
			log := logs[0]
			if log.DurationMS < (2*perImage).Milliseconds() || log.Stage != "backfill" || log.Requested != 2 || log.Images != 2-failures || log.Failed != failures {
				t.Fatalf("log = %+v", log)
			}
			if finished.StartedAt == nil || finished.FinishedAt == nil || log.DurationMS > finished.FinishedAt.Sub(*finished.StartedAt).Milliseconds() {
				t.Fatalf("duration exceeds pass lifetime: log = %+v, status = %+v", log, finished)
			}
		})
	}
}
