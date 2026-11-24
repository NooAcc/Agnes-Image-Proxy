export function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-[var(--component-radius)] border border-border bg-surface p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
