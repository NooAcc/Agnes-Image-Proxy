import { useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/errors";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel = "确认",
  onConfirm,
  pending = false,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<unknown>;
  pending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = pending || submitting;
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-sm text-danger">{errorMessage(error)}；请重试。</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={async (event) => {
              event.preventDefault();
              if (busy) return;
              setSubmitting(true);
              setError(null);
              try { await onConfirm(); setOpen(false); }
              catch (failure) { setError(failure); }
              finally { setSubmitting(false); }
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
