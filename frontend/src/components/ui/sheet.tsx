import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: "left" | "right";
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-y-0 z-50 flex h-full w-[min(20rem,85vw)] flex-col gap-4 overflow-y-auto bg-surface p-4 shadow-xl",
          side === "left" ? "left-0 border-r border-border" : "right-0 border-l border-border",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="关闭导航"
          className="absolute right-2 top-2 inline-flex size-11 items-center justify-center rounded-[var(--component-radius)] text-muted-foreground hover:bg-surface-muted"
        >
          <X aria-hidden="true" className="size-5" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />;
}

export { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger };
