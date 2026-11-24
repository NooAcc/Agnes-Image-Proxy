import { useEffect, useState } from "react";
import { ConfirmAction } from "@/components/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { blobCache } from "@/lib/blob-cache";
import type { GalleryItem, NsfwTag } from "@/lib/schemas";

const TAG_LABELS: Record<NsfwTag, string> = {
  safe: "安全",
  drawing: "绘画",
  sexy: "性感",
  porn: "色情",
  hentai: "成人",
  unclassified: "未分类",
};

const TAG_VARIANTS: Record<NsfwTag, "success" | "default" | "warning" | "danger" | "pending"> = {
  safe: "success",
  drawing: "default",
  sexy: "warning",
  porn: "danger",
  hentai: "danger",
  unclassified: "pending",
};

export function tagLabel(tag: NsfwTag): string {
  return TAG_LABELS[tag] ?? tag;
}

function useThumbnail(id: number) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let release = () => {};
    setUrl(null);
    setFailed(false);
    blobCache
      .load(id, "thumbnail", controller.signal)
      .then((result) => {
        if (!active) { result.release(); return; }
        release = result.release;
        setUrl(result.url);
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setFailed(true);
      });
    return () => {
      active = false;
      controller.abort();
      release();
    };
  }, [id]);

  return { url, failed };
}

function GalleryCard({
  item,
  onOpen,
  onDelete,
  deleting,
}: {
  item: GalleryItem;
  onOpen: () => void;
  onDelete: () => Promise<unknown>;
  deleting: boolean;
}) {
  const { url, failed } = useThumbnail(item.id);
  const alt = item.prompt || `图片 #${item.id}`;

  return (
    <li className="grid overflow-hidden rounded-[var(--component-radius)] border border-border bg-surface">
      <button
        type="button"
        onClick={onOpen}
        className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
      >
        <span className="sr-only">查看图片 #{item.id}：</span>
        {failed ? <span className="sr-only">缩略图不可用</span> : null}
        <div className="aspect-square w-full bg-surface-muted">
          {url ? (
            <img src={url} alt={alt} loading="lazy" className="size-full object-cover" />
          ) : failed ? (
            <div
              aria-hidden="true"
              className="grid size-full place-items-center p-3 text-center text-xs text-muted-foreground"
            >
              缩略图不可用
            </div>
          ) : (
            <Skeleton className="size-full rounded-none" />
          )}
        </div>
      </button>
      <div className="grid gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <Badge variant={TAG_VARIANTS[item.nsfwTag]}>{tagLabel(item.nsfwTag)}</Badge>
          <span className="text-xs text-muted-foreground">{item.createdAt.slice(0, 10)}</span>
        </div>
        <p className="line-clamp-2 text-sm">{item.prompt || "无提示词"}</p>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground">{item.model} · {item.size}</span>
          <ConfirmAction
            trigger={
              <Button variant="ghost" size="sm" aria-label={`删除图片 #${item.id}`} className="text-danger" disabled={deleting}>
                删除
              </Button>
            }
            title={`删除图片 #${item.id}？`}
            description="原图、缩略图与富化结果会被删除，无法恢复。"
            confirmLabel="删除"
            pending={deleting}
            onConfirm={onDelete}
          />
        </div>
      </div>
    </li>
  );
}

export { GalleryCard };
