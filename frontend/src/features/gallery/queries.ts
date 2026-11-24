import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, apiValidated } from "@/lib/api";
import { blobCache } from "@/lib/blob-cache";
import { queryKeys } from "@/lib/query-keys";
import {
  backfillStatusSchema,
  galleryPageSchema,
  type BackfillStatus,
} from "@/lib/schemas";

const PAGE_SIZE = 24;

export function useGallery(tag: string | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.gallery(tag),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (tag) params.set("tag", tag);
      if (pageParam !== null) params.set("before", String(pageParam));
      return apiValidated(galleryPageSchema, `/admin/api/gallery?${params.toString()}`, {
        signal,
      });
    },
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
  });
}

export function useBackfillStatus() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.backfill,
    queryFn: ({ signal }) =>
      apiValidated(backfillStatusSchema, "/admin/api/gallery/enrich", { signal }),
    refetchInterval: (queryState) => {
      const data = queryState.state.data as BackfillStatus | undefined;
      return data?.running && !document.hidden ? 2_000 : false;
    },
  });

  // While the tab is hidden polling stops; returning refreshes immediately.
  useEffect(() => {
    function onVisibility() {
      if (!document.hidden) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.backfill });
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [queryClient]);

  return query;
}

export function useStartBackfill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiValidated<BackfillStatus>(backfillStatusSchema, "/admin/api/gallery/enrich", {
        method: "POST",
      }),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.backfill, status);
    },
  });
}

export function useDeleteGallery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api<void>(`/admin/api/gallery/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      blobCache.remove(id);
      void queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
  });
}

export function useClearGallery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/admin/api/gallery", { method: "DELETE" }),
    onSuccess: () => {
      blobCache.clear();
      void queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
  });
}
