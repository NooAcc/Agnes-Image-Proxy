import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiValidated } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import {
  accountListSchema,
  accountSummarySchema,
  importResponseSchema,
  probeListSchema,
  probeResultSchema,
  type AccountPatch,
  type AccountSummary,
  type ImportAccountsResult,
  type ProbeResult,
} from "@/lib/schemas";

export function useAccounts() {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: ({ signal }) =>
      apiValidated(accountListSchema, "/admin/api/accounts", { signal }).then(
        (page) => page.items,
      ),
  });
}

function useInvalidateAccounts() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
}

export function useCreateAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (input: { name: string; apiKey: string }) =>
      apiValidated(accountSummarySchema, "/admin/api/accounts", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: AccountPatch }) =>
      apiValidated(accountSummarySchema, `/admin/api/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (id: number) =>
      api<void>(`/admin/api/accounts/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useProbeAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (id: number) =>
      apiValidated(probeResultSchema, `/admin/api/accounts/${id}/test`, {
        method: "POST",
      }),
    onSuccess: invalidate,
  });
}

export function useProbeAllAccounts() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: () =>
      apiValidated(probeListSchema, "/admin/api/accounts/test", { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useResetAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (id: number) =>
      api<void>(`/admin/api/accounts/${id}/reset`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useImportAccounts() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (accounts: { name: string; apiKey: string }[]) =>
      apiValidated<ImportAccountsResult>(importResponseSchema, "/admin/api/accounts/import", {
        method: "POST",
        body: JSON.stringify({ accounts }),
      }),
    onSuccess: invalidate,
  });
}

export type { AccountSummary, ProbeResult };
