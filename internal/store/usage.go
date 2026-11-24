package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/NooAcc/Agnes-Image-Proxy/internal/apierror"
	"github.com/NooAcc/Agnes-Image-Proxy/internal/domain"
)

const maxOverviewDays = 366

// Overview returns zero-filled UTC daily usage, model usage and account
// health for an inclusive day range.
func (s *Store) Overview(ctx context.Context, startDay, endDay string) (domain.Overview, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	start, err := time.Parse("2006-01-02", startDay)
	if err != nil {
		return domain.Overview{}, apierror.Invalid("start", "start must be a YYYY-MM-DD date", "invalid_value")
	}
	end, err := time.Parse("2006-01-02", endDay)
	if err != nil {
		return domain.Overview{}, apierror.Invalid("end", "end must be a YYYY-MM-DD date", "invalid_value")
	}
	if end.Before(start) {
		return domain.Overview{}, apierror.Invalid("end", "end must not be before start", "invalid_value")
	}
	days := int(end.Sub(start).Hours()/24) + 1
	if days < 1 || days > maxOverviewDays {
		return domain.Overview{}, apierror.Invalid("end", "date range must be between 1 and 366 days", "invalid_value")
	}

	dayTotals := make(map[string]domain.UsageTotals)
	rows, err := s.db.QueryContext(ctx,
		`SELECT day, SUM(requests), SUM(successes), SUM(partials), SUM(failures), SUM(images)
		 FROM model_usage_daily WHERE day >= ? AND day <= ? GROUP BY day`,
		startDay, endDay)
	if err != nil {
		return domain.Overview{}, classifyDBError(err)
	}
	for rows.Next() {
		var day string
		var totals domain.UsageTotals
		if err := rows.Scan(&day, &totals.Requests, &totals.Successes, &totals.Partials, &totals.Failures, &totals.Images); err != nil {
			rows.Close()
			return domain.Overview{}, classifyDBError(err)
		}
		dayTotals[day] = totals
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return domain.Overview{}, classifyDBError(err)
	}
	rows.Close()

	models := make([]domain.ModelUsage, 0)
	modelRows, err := s.db.QueryContext(ctx,
		`SELECT model, SUM(requests), SUM(successes), SUM(partials), SUM(failures), SUM(images)
		 FROM model_usage_daily WHERE day >= ? AND day <= ? GROUP BY model
		 ORDER BY SUM(requests) DESC, model ASC`,
		startDay, endDay)
	if err != nil {
		return domain.Overview{}, classifyDBError(err)
	}
	for modelRows.Next() {
		var model domain.ModelUsage
		if err := modelRows.Scan(&model.Model, &model.Requests, &model.Successes, &model.Partials, &model.Failures, &model.Images); err != nil {
			modelRows.Close()
			return domain.Overview{}, classifyDBError(err)
		}
		models = append(models, model)
	}
	if err := modelRows.Err(); err != nil {
		modelRows.Close()
		return domain.Overview{}, classifyDBError(err)
	}
	modelRows.Close()

	dayList := make([]domain.DailyUsage, 0, days)
	var totals domain.UsageTotals
	for i := 0; i < days; i++ {
		day := start.AddDate(0, 0, i).Format("2006-01-02")
		usage := dayTotals[day]
		dayList = append(dayList, domain.DailyUsage{Day: day, UsageTotals: usage})
		totals.Requests += usage.Requests
		totals.Successes += usage.Successes
		totals.Partials += usage.Partials
		totals.Failures += usage.Failures
		totals.Images += usage.Images
	}

	health, err := s.accountHealth(ctx)
	if err != nil {
		return domain.Overview{}, err
	}

	return domain.Overview{
		StartDay: startDay,
		EndDay:   endDay,
		Totals:   totals,
		Days:     dayList,
		Models:   models,
		Accounts: health,
	}, nil
}

func (s *Store) accountHealth(ctx context.Context) (domain.AccountHealth, error) {
	ctx, cancel := s.operation(ctx)
	defer cancel()
	now := formatTime(s.now())
	var (
		total    int
		disabled sql.NullInt64
		cooling  sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*),
			SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END),
			SUM(CASE WHEN enabled = 1 AND cooldown_until IS NOT NULL AND cooldown_until > ? THEN 1 ELSE 0 END)
		 FROM accounts`, now).Scan(&total, &disabled, &cooling)
	if err != nil {
		return domain.AccountHealth{}, classifyDBError(err)
	}
	health := domain.AccountHealth{
		Total:    total,
		Disabled: int(disabled.Int64),
		Cooling:  int(cooling.Int64),
	}
	health.Healthy = total - health.Disabled - health.Cooling
	if health.Healthy < 0 {
		health.Healthy = 0
	}
	return health, nil
}
