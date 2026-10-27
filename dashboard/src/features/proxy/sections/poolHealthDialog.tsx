import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Badge, type BadgeTone } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/state";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import { useNetworkPoolHealthEvents, useRecoverNetworkPool } from "../../../hooks/network";
import type { NetworkPoolResponse } from "../../../data/contracts";
import { poolName, proxyResponseLabel } from "./poolTable";

export function PoolHealthDialog({
  pool,
  onClose,
}: {
  readonly pool: NetworkPoolResponse;
  readonly onClose: () => void;
}): ReactNode {
  const query = useNetworkPoolHealthEvents(pool.id);
  const recover = useRecoverNetworkPool();
  const events = query.data ?? [];

  const proxyFailureLabel = proxyResponseLabel(pool.lastErrorCategory);
  const disabledForProxyResponse = pool.status === "disabled" && proxyFailureLabel !== undefined;
  const statusTone: BadgeTone =
    pool.status === "active" ? "ok" : pool.status === "disabled" ? "disabled" : "warn";
  return (
    <Dialog open onClose={onClose} title={`Health & Activity — ${poolName(pool)}`}>
      <Stack gap="14px">
        {/* A proxy rejected for payment/auth is a different situation from a
            plain disable, so its frame says so rather than leaving it to the badge. */}
        <div
          className={`flex items-center gap-8 rounded-panel border bg-surface-2 p-8 ${disabledForProxyResponse ? "border-orange" : "border-inner-border"}`}
        >
          <div className="min-w-0 flex-1">
            <div
              className="mb-2.5 text-text-tertiary text-micro font-bold tracking-label uppercase"
            >
              Proxy health
            </div>
            <div className="text-title font-bold leading-[1.3]">
              {disabledForProxyResponse ? "Proxy reachable" : `Proxy ${pool.status}`}
            </div>
            <p
              className="mt-3 mx-0 mb-0 text-text-secondary text-caption leading-normal wrap-anywhere"
            >
              {disabledForProxyResponse
                ? `${proxyFailureLabel} · disabled from routing`
                : pool.lastError ?? "No recent proxy errors."}
            </p>
          </div>
          <Badge tone={statusTone} dot>
            {pool.status}
          </Badge>
        </div>
        {(pool.status === "cooldown") && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={recover.isPending}
              onClick={() => recover.mutate(pool.id)}
              icon={<RotateCcw size={12} className={recover.isPending ? "animate-spin" : ""} />}
            >
              Recover Now
            </Button>
          </div>
        )}
        {/* `compact`: this panel sits inside a scroll region, so the state must
            not reserve the route-level centering floor. */}
        {query.isPending ? <LoadingState compact label="Loading pool activity…" /> : null}
        {query.isError ? <ErrorState compact message="Failed to load pool activity" onRetry={() => void query.refetch()} /> : null}
        {!query.isPending && !query.isError && events.length === 0 ? (
          <EmptyState compact title="No pool activity" message="Proxy checks, disable events, and recoveries will appear here." />
        ) : null}
        {events.length > 0 ? (
          <div
            className="grid gap-4 max-h-190 overflow-y-auto pr-1"
          >
            {events.map((event) => (
              <div
                key={event.id}
                className="p-6 border border-inner-border rounded-control bg-surface-1"
              >
                <div
                  className="flex flex-wrap items-center justify-between gap-4"
                >
                  <Inline gap="6px">
                    <Badge
                      tone={
                        event.toStatus === "active"
                          ? "ok"
                          : event.toStatus === "disabled"
                            ? "disabled"
                            : "warn"
                      }
                    >
                      {event.fromStatus ?? "new"} → {event.toStatus}
                    </Badge>
                    {event.errorCategory ? (
                      <Badge tone={event.errorCategory.startsWith("proxy_") ? "warn" : "err"}>
                        {event.errorCategory}
                      </Badge>
                    ) : null}
                  </Inline>
                  <time
                    className="text-text-tertiary text-badge tabular-nums"
                  >
                    {new Date(event.createdAt).toLocaleString()}
                  </time>
                </div>
                <p
                  className="mt-4 mx-0 mb-0 text-text-secondary text-caption leading-normal wrap-anywhere"
                >
                  {event.reason ?? "No additional details"}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </Stack>
    </Dialog>
  );
}
