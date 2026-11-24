import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";

export function LoadingState({ label = "加载中" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="grid gap-2">
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-5/6" />
      <Skeleton className="h-11 w-2/3" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorState({
  error,
  title = "加载失败",
  onRetry,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="grid gap-3 rounded-[var(--component-radius)] border border-border bg-surface p-4">
      <p className="text-sm font-medium text-danger">{title}</p>
      <p className="text-sm text-muted-foreground">{errorMessage(error)}</p>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry} className="w-fit">
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-2 rounded-[var(--component-radius)] border border-dashed border-border bg-surface p-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}
