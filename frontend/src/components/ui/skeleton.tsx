import type * as React from "react";
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-[var(--component-radius)] bg-surface-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
