import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-11 w-full rounded-[var(--component-radius)] border border-control bg-surface px-3 py-2 text-base text-foreground transition-colors duration-150 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
