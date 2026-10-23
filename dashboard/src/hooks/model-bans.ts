import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { ModelAbuseBan } from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { assertModelBans, querySignal } from "../data/assert";
import { DASHBOARD_MUTATION_OPTIONS, DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Platform-admin view of the model-abuse ban list.
 *
 * A ban is a security decision keyed on a client address, not a tenant
 * resource, so this surface is cross-tenant and gated by the server
 * (`platform:admin`); the dashboard only mirrors that gate to hide the control.
 * The list is small and short-lived (a ban lapses on its own after its TTL), so
 * it is read on demand when the dialog opens.
 */
export function useModelBans(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.modelBans.all,
    queryFn: (context) =>
      consoleRequest<unknown>("/model-bans", { signal: querySignal(context) }).then(assertModelBans),
    enabled,
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

/**
 * Lifts one ban by the opaque identity the listing reports.
 *
 * The identity, not the address: a ban can now be scoped to one API key from
 * an address, so the address alone does not name it. Unbanning by address would
 * either miss a scoped ban or lift the wrong one.
 *
 * The list is refetched rather than patched: the server is the authority on
 * which bans are still active, and a ban may have lapsed between the read and
 * the unban, which the response's `ban_not_found` surfaces honestly.
 */
export function useUnbanModel() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, ModelAbuseBan["identity"]>({
    mutationFn: (identity) =>
      consoleRequest<{ success: boolean }>("/model-bans", {
        method: "DELETE",
        body: JSON.stringify({ identity }),
      }),
    ...DASHBOARD_MUTATION_OPTIONS,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelBans.all });
    },
  });
}

/** One ban request: who to block, for how long, and whether to scope it. */
export interface BanRequest {
  readonly ip: string;
  /** The key to scope the ban to; omitted or null bans every key from the IP. */
  readonly apiKeyId?: string | null;
  /** Whole minutes, or null for permanent. */
  readonly minutes?: number | null;
  /** Bans the address outright regardless of `apiKeyId`. */
  readonly addressOnly?: boolean;
}

/**
 * Bans one caller immediately, for a chosen duration, bypassing the graduated
 * strike window. The operator action behind the request-detail "Banned User"
 * button.
 *
 * Default is one hour scoped to the request's key, because that is the
 * reversible answer: a ban on one credential from a shared address can be
 * lifted without collateral, and an hour lapses on its own. Every wider or
 * longer choice is opt-in through {@link BanRequest}.
 */
export function useBanIp() {
  const queryClient = useQueryClient();
  return useMutation<{ ban: ModelAbuseBan }, ApiErrorShape, BanRequest>({
    mutationFn: (request) =>
      consoleRequest<{ ban: ModelAbuseBan }>("/model-bans", {
        method: "POST",
        body: JSON.stringify({
          ip: request.ip,
          ...(request.apiKeyId === undefined
            ? {}
            : { apiKeyId: request.apiKeyId }),
          ...(request.minutes === undefined ? {} : { minutes: request.minutes }),
          ...(request.addressOnly === undefined ? {} : { addressOnly: true }),
        }),
      }),
    ...DASHBOARD_MUTATION_OPTIONS,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelBans.all });
    },
  });
}
