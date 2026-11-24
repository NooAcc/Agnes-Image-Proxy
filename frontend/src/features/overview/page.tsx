import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ErrorState, LoadingState } from "@/components/data-state";
import { StatTile } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DailyUsage, Overview, UsageTotals } from "@/lib/schemas";
import { useOverview } from "./queries";
import { UsageChart } from "./usage-chart";

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function zeroDay(day: string): DailyUsage {
  return { day, requests: 0, successes: 0, partials: 0, failures: 0, images: 0 };
}

// fillDays returns one UTC row per day in the response range, so a missing
// database row renders as a zero rather than disappearing.
function fillDays(overview: Overview): DailyUsage[] {
  const byDay = new Map(overview.days.map((day) => [day.day, day]));
  const start = Date.parse(`${overview.startDay}T00:00:00Z`);
  const end = Date.parse(`${overview.endDay}T00:00:00Z`);
  const days: DailyUsage[] = [];
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
    return [...overview.days].sort((a, b) => a.day.localeCompare(b.day));
  }
  for (let cursor = start; cursor <= end; cursor += DAY_MS) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    days.push(byDay.get(day) ?? zeroDay(day));
  }
  return days;
}

function UsageCells({ totals }: { totals: UsageTotals }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{totals.requests}</TableCell>
      <TableCell className="text-right tabular-nums">{totals.successes}</TableCell>
      <TableCell className="text-right tabular-nums">{totals.partials}</TableCell>
      <TableCell className="text-right tabular-nums">{totals.failures}</TableCell>
      <TableCell className="text-right tabular-nums">{totals.images}</TableCell>
    </>
  );
}

export function OverviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const end = searchParams.get("end") || utcDay();
  const start = searchParams.get("start") || utcDay(-6);
  const overview = useOverview(start, end);
  const [startInput, setStartInput] = useState(start);
  const [endInput, setEndInput] = useState(end);

  useEffect(() => {
    setStartInput(start);
    setEndInput(end);
  }, [start, end]);

  const days = useMemo(
    () => (overview.data ? fillDays(overview.data) : []),
    [overview.data],
  );

  function apply(event: FormEvent) {
    event.preventDefault();
    if (!startInput || !endInput) return;
    setSearchParams({ start: startInput, end: endInput }, { replace: true });
  }

  return (
    <section aria-labelledby="overview-heading" className="grid gap-4">
      <div>
        <h2 id="overview-heading" className="text-base font-semibold">总览</h2>
        <p className="text-sm text-muted-foreground">UTC 日期范围，缺省为最近 7 天。</p>
      </div>

      <section aria-label="日期范围" className="rounded-[var(--component-radius)] border border-border bg-surface p-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={apply}>
          <Field className="w-40">
            <FieldLabel htmlFor="overview-start">开始日期</FieldLabel>
            <Input id="overview-start" type="date" value={startInput} onChange={(event) => setStartInput(event.target.value)} />
          </Field>
          <Field className="w-40">
            <FieldLabel htmlFor="overview-end">结束日期</FieldLabel>
            <Input id="overview-end" type="date" value={endInput} onChange={(event) => setEndInput(event.target.value)} />
          </Field>
          <Button type="submit">应用</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const nextEnd = utcDay();
              const nextStart = utcDay(-29);
              setStartInput(nextStart);
              setEndInput(nextEnd);
              setSearchParams({ start: nextStart, end: nextEnd }, { replace: true });
            }}
          >
            最近 30 天
          </Button>
        </form>
      </section>

      {overview.isPending ? <LoadingState label="正在加载总览" /> : null}
      {overview.error ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : null}

      {overview.data ? (
        <>
          <section aria-label="总量指标" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <dl className="contents">
              <StatTile label="请求" value={overview.data.totals.requests} />
              <StatTile label="成功" value={overview.data.totals.successes} />
              <StatTile label="部分成功" value={overview.data.totals.partials} />
              <StatTile label="失败" value={overview.data.totals.failures} />
              <StatTile label="图片" value={overview.data.totals.images} />
            </dl>
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            <UsageChart days={days} metric="requests" />
            <UsageChart days={days} metric="images" />
          </div>

          <section aria-label="模型用量" className="grid gap-2 rounded-[var(--component-radius)] border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold">模型用量</h3>
            {overview.data.models.length === 0 ? (
              <p className="text-sm text-muted-foreground">该范围内没有模型用量。</p>
            ) : (
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">模型</TableHead>
                    <TableHead scope="col" className="text-right">请求</TableHead>
                    <TableHead scope="col" className="text-right">成功</TableHead>
                    <TableHead scope="col" className="text-right">部分成功</TableHead>
                    <TableHead scope="col" className="text-right">失败</TableHead>
                    <TableHead scope="col" className="text-right">图片</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.data.models.map((model) => (
                    <TableRow key={model.model}>
                      <TableCell className="break-all">{model.model}</TableCell>
                      <UsageCells totals={model} />
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell className="font-medium">合计</TableCell>
                    <UsageCells totals={overview.data.totals} />
                  </TableRow>
                </TableBody>
              </Table>
            )}
          </section>

          <section aria-label="账号健康" className="grid gap-2 rounded-[var(--component-radius)] border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold">账号健康</h3>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="总数" value={overview.data.accounts.total} />
              <StatTile label="健康" value={overview.data.accounts.healthy} />
              <StatTile label="冷却中" value={overview.data.accounts.cooling} />
              <StatTile label="已停用" value={overview.data.accounts.disabled} />
            </dl>
          </section>
        </>
      ) : null}
    </section>
  );
}
