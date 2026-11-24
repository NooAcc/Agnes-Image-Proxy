import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiValidated, advanceSessionGeneration } from "@/lib/api";
import { blobCache } from "@/lib/blob-cache";
import { queryKeys } from "@/lib/query-keys";
import { sessionSchema, type Session } from "@/lib/schemas";
import { useSessionState } from "@/lib/session-state";

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) =>
      apiValidated(sessionSchema, "/admin/api/session", { signal }),
    retry: false,
    staleTime: 10_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  const sessionState = useSessionState();
  return useMutation({
    mutationFn: (apiKey: string) =>
      api<Session>("/admin/api/session", {
        method: "POST",
        body: JSON.stringify({ apiKey }),
      }),
    onSuccess: async (session) => {
      advanceSessionGeneration();
      await queryClient.cancelQueries();
      queryClient.clear();
      blobCache.clear();
      queryClient.setQueryData(queryKeys.session, session);
      sessionState.reset();
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/admin/api/session", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.clear();
      blobCache.clear();
    },
  });
}

export function useRevokeSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/admin/api/session/revoke", { method: "POST" }),
    onSuccess: () => {
      queryClient.clear();
      blobCache.clear();
    },
  });
}
