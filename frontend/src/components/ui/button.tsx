import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--component-radius)] text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        outline: "border border-control bg-surface text-foreground hover:bg-surface-muted",
        ghost: "text-foreground hover:bg-surface-muted",
        destructive: "bg-danger text-danger-foreground hover:opacity-90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-4",
        sm: "h-11 px-3",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
