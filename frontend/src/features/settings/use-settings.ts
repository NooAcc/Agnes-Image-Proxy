import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiValidated } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { settingsSchema, type Settings } from "@/lib/schemas";

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) =>
      apiValidated(settingsSchema, "/admin/api/settings", { signal }),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: Settings) =>
      apiValidated(settingsSchema, "/admin/api/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      }),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
    },
  });
}
