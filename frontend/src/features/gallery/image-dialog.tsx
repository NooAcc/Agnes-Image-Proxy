import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { blobCache } from "@/lib/blob-cache";
import { errorMessage } from "@/lib/errors";
import type { GalleryItem } from "@/lib/schemas";
import { tagLabel } from "./cards";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; error: unknown };

export function ImageDialog({ item, onClose }: { item: GalleryItem; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const alt = item.prompt || `图片 #${item.id}`;

  useEffect(() => {
    if (!item.archived) {
      setState({ status: "error", error: new Error("not archived") });
      return;
    }
    const controller = new AbortController();
    let active = true;
    let release: () => void = () => {};
    setState({ status: "loading" });

    async function load() {
      try {
        const result = await blobCache.load(item.id, "image", controller.signal);
        if (!active) {
          result.release();
          return;
        }
        release = result.release;
        setState({ status: "ready", url: result.url });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setState({ status: "error", error });
      }
    }
    void load();

    return () => {
      active = false;
      controller.abort();
      release();
    };
  }, [item.id, item.archived, attempt]);

  async function copySource() {
    if (item.sourceUrl) {
      await navigator.clipboard?.writeText(item.sourceUrl);
    }
  }

  const failureDetail = state.status === "error" ? errorMessage(state.error) : "";

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-3xl flex-col overflow-y-auto [&>*]:shrink-0">
        <DialogHeader>
          <DialogTitle className="break-words">{alt}</DialogTitle>
          <DialogDescription>
            {item.createdAt.slice(0, 10)} · {item.model} · {item.size}
          </DialogDescription>
        </DialogHeader>

        {item.archived ? (
          <div className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-[var(--component-radius)] bg-surface-muted">
            {state.status === "loading" ? <Skeleton className="size-full rounded-none" /> : null}
            {state.status === "ready" ? (
              <img src={state.url} alt={alt} className="size-full object-contain" />
            ) : null}
            {state.status === "error" ? (
              <div className="grid gap-2 p-4 text-center">
                <p className="text-sm font-medium text-danger">图片加载失败</p>
                {failureDetail && failureDetail !== "图片加载失败" ? (
                  <p className="text-sm text-muted-foreground">{failureDetail}</p>
                ) : null}
                <Button variant="outline" className="mx-auto w-fit" onClick={() => setAttempt((value) => value + 1)}>
                  重试
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3 rounded-[var(--component-radius)] border border-border p-4">
            <Badge variant="pending" className="w-fit">未归档</Badge>
            <p className="text-sm text-muted-foreground">该图片没有保存原图，只保留了元数据。</p>
            {item.sourceUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary underline-offset-4 hover:underline"
                >
                  打开源链接
                </a>
                <Button variant="outline" size="sm" onClick={() => void copySource()}>
                  复制源链接
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">没有可用的源地址。</p>
            )}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">标签</dt>
          <dd>{tagLabel(item.nsfwTag)}</dd>
          <dt className="text-muted-foreground">账号</dt>
          <dd>{item.accountName || "—"}</dd>
          <dt className="text-muted-foreground">请求 ID</dt>
          <dd className="break-all font-mono text-xs">{item.requestId}</dd>
          <dt className="text-muted-foreground">富化状态</dt>
          <dd>{item.enrichStatus}</dd>
        </dl>

        {item.archived ? (
          <a
            href={`/admin/api/gallery/${item.id}/content?download=1`}
            className="w-fit text-sm text-primary underline-offset-4 hover:underline"
          >
            下载原图
          </a>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
