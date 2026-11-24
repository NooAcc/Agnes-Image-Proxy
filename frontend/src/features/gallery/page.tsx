import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState, ErrorState, LoadingState } from "@/components/data-state";
import { Button } from "@/components/ui/button";
import type { GalleryItem } from "@/lib/schemas";
import { BackfillStatusPanel } from "./backfill-status";
import { GalleryCard } from "./cards";
import { ImageDialog } from "./image-dialog";
import { useClearGallery, useDeleteGallery, useGallery } from "./queries";

const TAG_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "全部" },
  { value: "safe", label: "安全" },
  { value: "drawing", label: "绘画" },
  { value: "sexy", label: "性感" },
  { value: "porn", label: "色情" },
  { value: "hentai", label: "成人" },
  { value: "unclassified", label: "未分类" },
];

export function GalleryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tag = searchParams.get("tag") ?? "";
  const gallery = useGallery(tag || null);
  const remove = useDeleteGallery();
  const clear = useClearGallery();
  const [selected, setSelected] = useState<GalleryItem | null>(null);

  const items = useMemo(
    () => gallery.data?.pages.flatMap((page) => page.items) ?? [],
    [gallery.data],
  );
  const groups = useMemo(() => {
    const map = new Map<string, GalleryItem[]>();
    for (const item of items) {
      const day = item.createdAt.slice(0, 10);
      const bucket = map.get(day) ?? [];
      bucket.push(item);
      map.set(day, bucket);
    }
    return [...map.entries()];
  }, [items]);

  function changeTag(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("tag", value);
    else next.delete("tag");
    setSearchParams(next, { replace: true });
  }

  return (
    <section aria-labelledby="gallery-heading" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="gallery-heading" className="text-base font-semibold">图库</h2>
          <p className="text-sm text-muted-foreground">按 UTC 日期分组；缩略图懒加载，原图按需打开。</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <label htmlFor="gallery-tag" className="text-sm font-medium">标签</label>
            <select
              id="gallery-tag"
              value={tag}
              onChange={(event) => changeTag(event.target.value)}
              className="h-11 rounded-[var(--component-radius)] border border-control bg-surface px-2 text-sm text-foreground"
            >
              {TAG_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <ConfirmAction
            trigger={<Button variant="outline">清空图库</Button>}
            title="清空全部图库？"
            description="所有原图、缩略图与富化结果会被删除；日志与用量不受影响。"
            confirmLabel="清空图库"
            pending={clear.isPending}
            onConfirm={() => clear.mutateAsync()}
          />
        </div>
      </div>

      <BackfillStatusPanel />

      {gallery.isPending ? <LoadingState label="正在加载图库" /> : null}
      {gallery.error ? (
        <ErrorState error={gallery.error} onRetry={() => void gallery.refetch()} />
      ) : null}
      {gallery.data && items.length === 0 ? (
        <EmptyState title="没有图片" description="生成图片或调整标签筛选后会在此显示。" />
      ) : null}

      {groups.map(([day, dayItems]) => (
        <section key={day} aria-label={`${day} 的图片`} className="grid gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">{day}</h3>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {dayItems.map((item) => (
              <GalleryCard
                key={item.id}
                item={item}
                onOpen={() => setSelected(item)}
                onDelete={() => remove.mutateAsync(item.id)}
                deleting={remove.isPending && remove.variables === item.id}
              />
            ))}
          </ul>
        </section>
      ))}

      {gallery.hasNextPage ? (
        <Button
          variant="outline"
          className="w-fit"
          disabled={gallery.isFetchingNextPage}
          onClick={() => void gallery.fetchNextPage()}
        >
          {gallery.isFetchingNextPage ? "加载中…" : "加载更多"}
        </Button>
      ) : null}

      {selected ? (
        <ImageDialog key={selected.id} item={selected} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}
