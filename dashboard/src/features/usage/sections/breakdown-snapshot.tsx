import { useMemo, type ReactNode } from "react";
import { Wrench } from "lucide-react";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/state";
import { useProviders } from "../../../hooks/providers";
import { useUsageBy } from "../../../hooks/system";
import { formatNumber } from "../../../lib/format/numbers";
import { formatTokens } from "../../../lib/format/tokens";
import type { UsagePeriod as Period } from "../../../data/usage-periods";
import type { UsageDimension } from "../../../data/contracts";
import { PanelWidthToggle, PillTabs } from "./controls";
import { formatUsd } from "./formatters";

/** Breakdown rows the panel holds before it scrolls; the rest scrolls inside.
 *  The body is locked to this height so the card keeps it when the list is
 *  empty, loading, or short. */
const BREAKDOWN_VISIBLE_ROWS = 6;
/** Measured row box (39px) plus the 8px flex gap, minus the trailing gap. */
const BREAKDOWN_LIST_HEIGHT = BREAKDOWN_VISIBLE_ROWS * 47 - 8;

export function BreakdownSnapshot({
  period,
  dimension,
  onDimensionChange,
  wide,
  onToggleWide,
}: {
  readonly period: Period;
  readonly dimension: UsageDimension;
  readonly onDimensionChange: (value: UsageDimension) => void;
  readonly wide: boolean;
  readonly onToggleWide: () => void;
}): ReactNode {
  const byQuery = useUsageBy(period, dimension);
  const providersQuery = useProviders();
  const providerNames = useMemo(
    () => new Map((providersQuery.data ?? []).map((provider) => [provider.providerId, provider.label || provider.displayName])),
    [providersQuery.data],
  );
  // A response that names another dimension is a tab the operator already left.
  // Showing it would leave the list unchanged after the click.
  const rows = byQuery.data?.dimension === dimension ? byQuery.data.rows : [];
  const maxTotal = rows.length > 0 ? Math.max(...rows.map((row) => row.total)) : 1;
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  const totalErrors = rows.reduce((sum, row) => sum + row.errors, 0);
  const breakdownSubtitle = (() => {
    if (byQuery.isPending && rows.length === 0) return "Loading…";
    if (rows.length === 0) return "No traffic in this period";
    const ok = Math.max(0, totalRequests - totalErrors);
    const pct = totalRequests > 0 ? Math.round((ok / totalRequests) * 100) : 0;
    const plural = rows.length === 1 ? "group" : "groups";
    return `${rows.length} ${plural} · ${formatNumber(totalRequests)} hits · ${pct}% ok`;
  })();
  return (
    <Card className={wide ? "col-span-full" : ""}>
      <CardHeader
        title="Breakdown"
        subtitle={breakdownSubtitle}
        icon={<Wrench size={16} />}
        leading={
          <PanelWidthToggle label="Breakdown" wide={wide} onToggleWide={onToggleWide} />
        }
        action={
          <PillTabs
            ariaLabel="Breakdown dimension"
            value={dimension}
            onChange={onDimensionChange}
            options={[
              { id: "model", label: "Model" },
              { id: "provider", label: "Provider" },
              { id: "client", label: "Client" },
              { id: "client_ip", label: "Client IP" },
              { id: "key", label: "Key" },
            ]}
          />
        }
      />
      <CardBody style={{ height: `${BREAKDOWN_LIST_HEIGHT}px` }}>
        {byQuery.isPending && rows.length === 0 ? (
          <LoadingState label="Loading breakdown…" />
        ) : byQuery.isError && rows.length === 0 ? (
          <ErrorState message="Failed to load breakdown." onRetry={() => void byQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No usage for this period" message="Route requests to populate the breakdown." />
        ) : (
          <div
            className="scroll-region flex h-full flex-col gap-4 pr-1"
          >
            {rows.map((row) => {
              const pct = maxTotal > 0 ? Math.max(2, (row.total / maxTotal) * 100) : 2;
              const displayName =
                dimension === "provider"
                  ? (providerNames.get(row.name) ?? row.name)
                  : dimension === "key"
                    ? (row.label ?? `${row.name.slice(0, 8)}…`)
                    : row.name;
              const okCount = Math.max(0, row.requests - row.errors);
              return (
                <div
                  key={row.name}
                  title={`${displayName} · ${formatNumber(row.requests)} hits · ${formatNumber(okCount)} ok · ${formatNumber(row.total)} tokens · ${formatUsd(row.costUsd)}`}
                  className="relative shrink-0 overflow-hidden rounded-control border border-inner-border bg-surface-2"
                >
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--accent)_20%,transparent),transparent)]"
                    style={{ width: `${pct}%` }}
                  />
                  <div
                    className="relative flex items-center justify-between gap-4 px-6 py-5"
                  >
                    <span
                      className="truncate font-mono tabular-nums min-w-0 flex-1 text-badge font-semibold"
                    >
                      {displayName}
                    </span>                    <span
                      className="font-mono tabular-nums shrink-0 text-micro text-text-secondary"
                    >
                      {formatNumber(row.requests)} hit · {formatNumber(okCount)} ok
                    </span>
                    <span className="shrink-0 text-badge font-bold text-orange">
                      {formatUsd(row.costUsd)}
                    </span>
                    <span className="shrink-0 text-badge font-bold text-purple">
                      {formatTokens(row.total)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
