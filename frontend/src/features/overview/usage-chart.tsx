import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DailyUsage } from "@/lib/schemas";

const WIDTH = 720;
const HEIGHT = 220;
const PADDING = { left: 44, right: 16, top: 16, bottom: 32 };

export function UsageChart({
  days,
  metric,
}: {
  days: DailyUsage[];
  metric: "requests" | "images";
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const label = metric === "requests" ? "请求" : "图片";
  const title = `${label}趋势`;

  if (days.length === 0) {
    return (
      <section aria-label={title} className="grid gap-2 rounded-[var(--component-radius)] border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">暂无数据</p>
      </section>
    );
  }

  const values = days.map((day) => day[metric]);
  const max = Math.max(0, ...values);
  const scaleMax = max > 0 ? max : 1;
  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const x = (index: number) =>
    days.length === 1
      ? PADDING.left + innerWidth / 2
      : PADDING.left + (index / (days.length - 1)) * innerWidth;
  const y = (value: number) => PADDING.top + innerHeight - (value / scaleMax) * innerHeight;
  const line = days.map((day, index) => `${x(index)},${y(day[metric])}`).join(" ");
  const active = selected !== null ? days[selected] : null;

  return (
    <section aria-label={title} className="grid gap-3 rounded-[var(--component-radius)] border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="grid gap-1">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-56 w-full"
          role="group"
          aria-label={`${title}折线图，共 ${days.length} 天`}
        >
          {[0, 0.5, 1].map((fraction) => {
            const value = Math.round(scaleMax * fraction);
            const lineY = y(value);
            return (
              <g key={fraction}>
                <line
                  x1={PADDING.left}
                  x2={WIDTH - PADDING.right}
                  y1={lineY}
                  y2={lineY}
                  className="stroke-border"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
                <text
                  x={PADDING.left - 8}
                  y={lineY + 4}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  fontSize={11}
                >
                  {value}
                </text>
              </g>
            );
          })}
          <polyline points={line} fill="none" className="stroke-primary" strokeWidth={2} />
          {days.map((day, index) => (
            <circle
              key={`dot-${day.day}`}
              cx={x(index)}
              cy={y(day[metric])}
              r={selected === index ? 5 : 3}
              className="fill-primary"
            />
          ))}
          {days.map((day, index) => (
            <circle
              key={`hit-${day.day}`}
              cx={x(index)}
              cy={y(day[metric])}
              r={14}
              className="cursor-pointer fill-transparent"
              role="button"
              tabIndex={0}
              aria-label={`${day.day}：${day[metric]}`}
              onFocus={() => setSelected(index)}
              onMouseEnter={() => setSelected(index)}
              onClick={() => setSelected(index)}
            />
          ))}
          {days.map((day, index) =>
            index % Math.max(1, Math.ceil(days.length / 6)) === 0 ? (
              <text
                key={`label-${day.day}`}
                x={x(index)}
                y={HEIGHT - 10}
                textAnchor="middle"
                className="fill-muted-foreground"
                fontSize={11}
              >
                {day.day.slice(5)}
              </text>
            ) : null,
          )}
        </svg>
        <p role="status" className="min-h-6 text-sm text-muted-foreground">
          {active ? `${active.day} · ${active[metric]} ${label}` : "聚焦数据点查看数值"}
        </p>
      </div>
      <Table aria-label={`${label}逐日数据`}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">日期</TableHead>
            <TableHead scope="col" className="text-right">{label}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.map((day) => (
            <TableRow key={day.day}>
              <TableCell>{day.day}</TableCell>
              <TableCell className="text-right tabular-nums">{day[metric]}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
