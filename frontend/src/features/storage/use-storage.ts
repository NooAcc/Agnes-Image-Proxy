import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiValidated } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import {
  storageInitSchema,
  storageStatusSchema,
  storageUpdateSchema,
  type StorageInit,
  type StorageStatus,
  type StorageUpdate,
} from "@/lib/schemas";

export function useStorage() {
  return useQuery({
    queryKey: queryKeys.storage,
    queryFn: ({ signal }) => apiValidated(storageStatusSchema, "/admin/api/storage", { signal }),
    // Another tab may initialize storage; always re-read on mount.
    staleTime: 2_000,
    refetchOnMount: "always",
    retry: false,
  });
}

export function useInitializeStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StorageInit) =>
      apiValidated<StorageStatus>(storageStatusSchema, "/admin/api/storage", {
        method: "POST",
        body: JSON.stringify(storageInitSchema.parse(input)),
      }),
    // Settled mutations would otherwise retain request variables (including the
    // token) in the in-memory cache.
    gcTime: 0,
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.storage, status);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        // Another tab won the race: refetch the fixed status instead of
        // reopening the choice or flashing the console.
        void queryClient.invalidateQueries({ queryKey: queryKeys.storage });
      }
    },
  });
}

export function useUpdateImgbedStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StorageUpdate) =>
      apiValidated<StorageStatus>(storageStatusSchema, "/admin/api/storage", {
        method: "PUT",
        body: JSON.stringify(storageUpdateSchema.parse(input)),
      }),
    gcTime: 0,
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.storage, status);
    },
  });
}
