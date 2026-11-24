import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { useBackfillStatus, useStartBackfill } from "./queries";

export function BackfillStatusPanel() {
  const status = useBackfillStatus();
  const start = useStartBackfill();
  const queryClient = useQueryClient();
  const wasRunning = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const running = status.data?.running ?? false;
    if (wasRunning.current && !running && status.data) {
      const { processed, succeeded, failed } = status.data;
      setAnnouncement(
        processed === 0
          ? "没有需要补齐的图片"
          : `富化完成：处理 ${processed} 项，成功 ${succeeded} 项，失败 ${failed} 项`,
      );
      void queryClient.invalidateQueries({ queryKey: ["gallery"] });
    }
    wasRunning.current = running;
  }, [status.data, queryClient]);

  const data = status.data;
  const running = data?.running ?? false;

  return (
    <section aria-labelledby="backfill-heading" className="grid gap-2 rounded-[var(--component-radius)] border border-border bg-surface p-3">
      <h3 id="backfill-heading" className="text-sm font-semibold">元数据补齐</h3>
      <p className="text-sm text-muted-foreground">
        已处理 {data?.processed ?? 0} 项 · 成功 {data?.succeeded ?? 0} 项 · 失败 {data?.failed ?? 0} 项
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={running || start.isPending || status.isPending}
          onClick={() =>
            start.mutate(undefined, {
              onSuccess: (next) => {
                if (!next.running && next.processed === 0) {
                  setAnnouncement("没有需要补齐的图片");
                } else if (next.running) {
                  setAnnouncement("富化任务已开始");
                }
              },
            })
          }
        >
          {running || start.isPending ? "补齐中…" : "补齐元数据"}
        </Button>
      </div>
      {start.error ? (
        <p role="alert" className="text-sm font-medium text-danger">{errorMessage(start.error)}</p>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm">{announcement}</p>
    </section>
  );
}
