import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type {
  RemoteSupportStartResponse,
  RemoteSupportStatus,
  RemoteSupportTool,
} from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Live tunnel state, polled because the tunnel can also be stopped out of band. */
export function useRemoteSupport() {
  return useQuery<RemoteSupportStatus>({
    queryKey: queryKeys.remoteSupport.status,
    queryFn: () => consoleRequest<RemoteSupportStatus>("/remote-support/status"),
  });
}

/** Starts a publisher. `not_installed` comes back as data, not as a failure. */
export function useStartRemoteSupport() {
  const queryClient = useQueryClient();
  return useMutation<RemoteSupportStartResponse, ApiErrorShape, RemoteSupportTool>({
    mutationFn: (tool) =>
      consoleRequest<RemoteSupportStartResponse>("/remote-support/start", {
        method: "POST",
        body: JSON.stringify({ tool }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.remoteSupport.status });
    },
  });
}

/** Stops one publisher, or every running one when `tool` is omitted. */
export function useStopRemoteSupport() {
  const queryClient = useQueryClient();
  return useMutation<RemoteSupportStatus, ApiErrorShape, RemoteSupportTool | undefined>({
    mutationFn: (tool) =>
      consoleRequest<RemoteSupportStatus>("/remote-support/stop", {
        method: "POST",
        body: JSON.stringify(tool === undefined ? {} : { tool }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.remoteSupport.status });
    },
  });
}
