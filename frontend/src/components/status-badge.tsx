import { AlertTriangle, CheckCircle2, Clock, CircleDashed } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type BadgeVariant = "success" | "warning" | "danger" | "pending";

const STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  healthy: { label: "健康", variant: "success" },
  success: { label: "成功", variant: "success" },
  ok: { label: "正常", variant: "success" },
  cooling: { label: "冷却中", variant: "warning" },
  pending: { label: "待处理", variant: "pending" },
  disabled: { label: "已停用", variant: "danger" },
  failed: { label: "失败", variant: "danger" },
  error: { label: "错误", variant: "danger" },
};

const ICONS = {
  success: CheckCircle2,
  warning: Clock,
  danger: AlertTriangle,
  pending: CircleDashed,
};

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  const entry = STATUS[status] ?? { label: status, variant: "pending" as const };
  const Icon = ICONS[entry.variant];
  return (
    <Badge variant={entry.variant} className={className}>
      <Icon aria-hidden="true" className="size-3.5" />
      <span>{label ?? entry.label}</span>
    </Badge>
  );
}
