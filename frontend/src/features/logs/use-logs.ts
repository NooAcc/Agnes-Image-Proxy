import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiValidated } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { logPageSchema, type LogCategory } from "@/lib/schemas";

export function useLogs(category: LogCategory, before: number | null) {
  return useQuery({
    queryKey: queryKeys.logs(category, before),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ category, limit: "20" });
      if (before !== null) params.set("before", String(before));
      return apiValidated(logPageSchema, `/admin/api/logs?${params.toString()}`, { signal });
    },
  });
}

export function useClearLogs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/admin/api/logs", { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["logs"] }),
  });
}
