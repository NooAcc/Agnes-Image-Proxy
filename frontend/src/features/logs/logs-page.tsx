import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState, ErrorState, LoadingState } from "@/components/data-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LogCategory, RequestLog } from "@/lib/schemas";
import { useClearLogs, useLogs } from "./use-logs";
import { cn } from "@/lib/utils";

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)}`;
}

function LogDetail({ log, onClose }: { log: RequestLog | null; onClose: () => void }) {
  return (
    <Dialog open={log !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>请求 {log?.requestId}</DialogTitle>
          <DialogDescription>{log ? formatTimestamp(log.ts) : ""}</DialogDescription>
        </DialogHeader>
        {log ? (
          <div className="grid gap-4 text-sm">
            <dl className="grid grid-cols-2 gap-2">
              <dt className="text-muted-foreground">阶段</dt><dd>{log.stage}</dd>
              <dt className="text-muted-foreground">模型</dt><dd>{log.model || "—"}</dd>
              <dt className="text-muted-foreground">状态</dt><dd>{log.status}</dd>
              <dt className="text-muted-foreground">尺寸</dt>
              <dd>{log.sizeActual ?? log.sizeRequest ?? "—"}</dd>
              <dt className="text-muted-foreground">请求/图片/失败</dt>
              <dd>{log.requested} / {log.images} / {log.failed}</dd>
              <dt className="text-muted-foreground">耗时</dt><dd>{log.durationMs} ms</dd>
            </dl>
            {log.deliveryFailures.length > 0 ? (
              <div>
                <p className="mb-1 font-medium">图片交付失败</p>
                <Table className="min-w-[520px]">
                  <TableHeader><TableRow>
                    <TableHead scope="col">子请求</TableHead><TableHead scope="col">图片序号</TableHead>
                    <TableHead scope="col">阶段</TableHead><TableHead scope="col">状态</TableHead><TableHead scope="col">代码</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>{log.deliveryFailures.map((failure, index) => (
                    <TableRow key={index}><TableCell>{failure.subrequestIndex}</TableCell><TableCell>{failure.imageIndex}</TableCell>
                      <TableCell>{failure.stage}</TableCell><TableCell>{failure.status}</TableCell><TableCell>{failure.code}</TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              </div>
            ) : null}
            <div>
              <p className="mb-1 font-medium">账号尝试</p>
              {log.attempts.length === 0 ? (
                <p className="text-muted-foreground">没有上游尝试。</p>
              ) : (
                <Table className="min-w-[520px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">账号</TableHead>
                      <TableHead scope="col">状态</TableHead>
                      <TableHead scope="col">耗时</TableHead>
                      <TableHead scope="col">消息</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {log.attempts.map((attempt, index) => (
                      <TableRow key={`${attempt.accountId}-${index}`}>
                        <TableCell>{attempt.accountName || attempt.accountId}</TableCell>
                        <TableCell>{attempt.status}</TableCell>
                        <TableCell>{attempt.durationMs} ms</TableCell>
                        <TableCell className="text-muted-foreground">{attempt.message || attempt.code || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function LogsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const category: LogCategory = searchParams.get("category") === "enrich" ? "enrich" : "request";
  const [before, setBefore] = useState<number | null>(null);
  const [selected, setSelected] = useState<RequestLog | null>(null);
  const logs = useLogs(category, before);
  const clear = useClearLogs();

  function switchCategory(next: LogCategory) {
    const params = new URLSearchParams(searchParams);
    params.set("category", next);
    setSearchParams(params, { replace: true });
    setBefore(null);
  }

  return (
    <section aria-labelledby="logs-heading" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="logs-heading" className="text-base font-semibold">请求日志</h2>
          <p className="text-sm text-muted-foreground">请求与富化任务分别记录，日志文本按纯文本展示。</p>
        </div>
        <ConfirmAction
          trigger={<Button variant="outline">清空日志</Button>}
          title="清空全部日志？"
          description="日志与明细将被删除，用量汇总保持不变。"
          confirmLabel="清空日志"
          pending={clear.isPending}
          onConfirm={() => clear.mutate()}
        />
      </div>

      <div role="tablist" aria-label="日志分类" className="flex gap-1">
        {(["request", "enrich"] as const).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={category === value}
            onClick={() => switchCategory(value)}
            className={cn(
              "min-h-11 rounded-[var(--component-radius)] px-3 text-sm",
              category === value
                ? "bg-surface-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
            )}
          >
            {value === "request" ? "请求" : "富化"}
          </button>
        ))}
      </div>

      {logs.isPending ? <LoadingState label="正在加载日志" /> : null}
      {logs.error ? <ErrorState error={logs.error} onRetry={() => void logs.refetch()} /> : null}
      {logs.data && logs.data.items.length === 0 ? (
        <EmptyState title="没有日志" description="产生图片请求或富化任务后会在此显示。" />
      ) : null}
      {logs.data && logs.data.items.length > 0 ? (
        <ul className="grid gap-2">
          {logs.data.items.map((log) => (
            <li
              key={log.id}
              className="grid gap-2 rounded-[var(--component-radius)] border border-border bg-surface p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="grid gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={log.ok ? "success" : "failed"} label={String(log.status)} />
                  <span className="font-mono text-xs">{log.requestId}</span>
                  <span className="text-xs text-muted-foreground">{formatTimestamp(log.ts)}</span>
                </div>
                <p className="text-sm">
                  {log.stage} · {log.model || "无模型"} · 请求 {log.requested} / 图片 {log.images} / 失败 {log.failed}
                </p>
                <p className="text-xs text-muted-foreground">
                  {log.durationMs} ms · {log.sizeActual ?? log.sizeRequest ?? "无尺寸"}
                </p>
              </div>
              <Button variant="outline" aria-label={`查看 ${log.requestId} 详情`} onClick={() => setSelected(log)}>
                详情
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {logs.data?.nextBefore ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setBefore(logs.data?.nextBefore ?? null)}>
            加载更多
          </Button>
          {before !== null ? (
            <Button variant="ghost" onClick={() => setBefore(null)}>返回最新</Button>
          ) : null}
        </div>
      ) : null}

      <LogDetail log={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
