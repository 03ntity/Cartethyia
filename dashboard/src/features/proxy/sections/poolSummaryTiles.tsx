import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Activity, Cloud, Gauge, ShieldCheck } from "lucide-react";
import { formatBytes } from "../../../lib/format/numbers";
import { StatCard } from "../../../components/ui/layout";
import { summarizePools, type ProxyPoolSummary } from "../proxy-metrics";
import type { NetworkPoolResponse } from "../../../data/contracts";
import { usePoolUsage, type PoolUsageRow } from "../../../hooks/live";

/** Averages are only meaningful once something has been measured; say so
 * plainly instead of showing a confident `0ms`. */
function latencyDetail(summary: ProxyPoolSummary): string {
  if (summary.avgLatencyMs === null) return "no measurement yet";
  return `avg across ${summary.measuredPools} enabled ${summary.measuredPools === 1 ? "pool" : "pools"}`;
}

/**
 * Live per-pool usage, held above the page body.
 *
 * The stream ticks whenever a pool acquires or releases a slot. Subscribing in
 * the page component itself re-rendered the whole page — every row, every
 * handler — on each tick, which is what made a busy Proxy page feel heavy. The
 * subscription lives here instead and children pass through as a prop, so the
 * subtree stays referentially stable and a tick re-renders only the two
 * components that read this context. One stream per open page.
 */
export const PoolUsageContext = createContext<{
  readonly byId: ReadonlyMap<string, PoolUsageRow>;
  readonly live: boolean;
}>({ byId: new Map(), live: false });

export function ProxyLiveProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const usage = usePoolUsage();
  const byId = useMemo(
    () => new Map((usage.pools ?? []).map((row) => [row.poolId, row] as const)),
    [usage.pools],
  );
  const value = useMemo(
    () => ({ byId, live: usage.live && usage.pools !== null }),
    [byId, usage.live, usage.pools],
  );
  return <PoolUsageContext.Provider value={value}>{children}</PoolUsageContext.Provider>;
}

/**
 * The four summary tiles. Split out because the live stream moves three of
 * them; keeping them in the page would re-render the table below on every tick.
 */
export function ProxySummaryTiles({ pools }: { readonly pools: readonly NetworkPoolResponse[] }): ReactNode {
  const { byId, live } = useContext(PoolUsageContext);
  const summary = useMemo(
    () =>
      summarizePools(
        pools,
        live ? new Map([...byId].map(([id, row]) => [id, row.currentInflight] as const)) : undefined,
      ),
    [pools, byId, live],
  );
  // Cumulated metered usage across all proxies: the same max(metered, session)
  // rule as the per-row bar, so the tile and the rows can never disagree.
  const quota = useMemo(() => {
    let used = 0;
    let allowance = 0;
    for (const pool of pools) {
      const row = live ? byId.get(pool.id) : undefined;
      const metered = (pool.bytesSentTotal ?? 0) + (pool.bytesReceivedTotal ?? 0);
      const session = (row?.bytesSent ?? 0) + (row?.bytesReceived ?? 0);
      used += Math.max(metered, session);
      if (pool.quotaBytes) allowance += pool.quotaBytes;
    }
    return { used, allowance };
  }, [pools, byId, live]);
  return (
    <div
      className="signal-grid grid gap-7 w-full min-w-0 mb-7"
    >
      <StatCard
        label="Enabled pool"
        value={String(summary.active)}
        detail={`/ ${summary.totalPools} total`}
        tone="accent"
        icon={<ShieldCheck size={13} />}
      />
      <StatCard
        label="Route capacity"
        value={String(summary.totalMaxConcurrency)}
        detail={`${summary.usedInflight} inflight · ${summary.availableCapacity} available`}
        tone={summary.availableCapacity === 0 ? "orange" : "teal"}
        icon={<Gauge size={13} />}
      />
      <StatCard
        label="Latency"
        value={summary.avgLatencyMs === null ? "—" : `${summary.avgLatencyMs}ms`}
        detail={latencyDetail(summary)}
        tone={
          summary.avgLatencyMs === null
            ? "accent"
            : summary.avgLatencyMs > 2000
              ? "orange"
              : "teal"
        }
        icon={<Activity size={13} />}
      />
      <StatCard
        label="Quota usage"
        value={formatBytes(quota.used)}
        detail={
          quota.allowance > 0
            ? `of ${formatBytes(quota.allowance)} allowance · ${pools.length} pools`
            : `${pools.length} pools · no allowance set`
        }
        tone={quota.allowance > 0 && quota.used > quota.allowance ? "red" : quota.allowance > 0 && quota.used / quota.allowance >= 0.8 ? "orange" : "teal"}
        icon={<Cloud size={13} />}
      />
    </div>
  );
}
