import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiValidated } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { overviewSchema } from "@/lib/schemas";
import { useSettings } from "@/features/settings/use-settings";

export function useOverview(start: string, end: string) {
  const settings = useSettings();
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const query = useQuery({
    queryKey: queryKeys.overview(start, end),
    queryFn: ({ signal }) => apiValidated(overviewSchema, `/admin/api/overview?start=${start}&end=${end}`, { signal }),
  });
  const refetch = query.refetch;
  useEffect(() => {
    const changed = () => {
      const next = document.visibilityState !== "hidden";
      setVisible(next);
      if (next) void refetch();
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, [refetch]);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => void refetch(), settings.data?.autoRefreshIntervalMs ?? 5000);
    return () => window.clearInterval(timer);
  }, [visible, refetch, settings.data?.autoRefreshIntervalMs]);
  return query;
}
