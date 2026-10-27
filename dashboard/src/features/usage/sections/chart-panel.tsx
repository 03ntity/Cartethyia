import { useMemo, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsagePeriod as Period } from "../../../data/usage-periods";
import { useUsageChart } from "../../../hooks/system";
import { useReducedMotion } from "../../../hooks/use-reduced-motion";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/state";
import { formatChartTick, formatChartTooltip } from "../../../lib/format/instants";
import { formatTokens } from "../../../lib/format/tokens";
import { formatNumber } from "../../../lib/format/numbers";

export type Metric = "requests" | "tokens" | "cached";

export function ChartPanel({ period, metric }: { readonly period: Period; readonly metric: Metric }): ReactNode {
  const chartQuery = useUsageChart(period);
  const reducedMotion = useReducedMotion();
  const buckets = useMemo(
    () => (chartQuery.data?.buckets ?? []).map((bucket) => ({ ...bucket, total: bucket.input + bucket.output })),
    [chartQuery.data],
  );
  const dataKey = metric === "requests" ? "requests" : metric === "cached" ? "cached" : "total";
  // The backend fills every bucket of the window, so an idle period arrives as
  // a full series of zeroes rather than an empty array. A chart of that draws
  // nothing — a blank strip — so it reads as empty instead.
  const hasTraffic = buckets.some((bucket) => bucket[dataKey] > 0);
  if (chartQuery.isPending && !hasTraffic) {
    return <LoadingState label="Loading chart…" />;
  }
  if (chartQuery.isError && !hasTraffic) {
    return <ErrorState message="Failed to load chart data." onRetry={() => void chartQuery.refetch()} />;
  }
  if (!hasTraffic) {
    return (
      <EmptyState
        title="No usage for this period"
        message="Route requests to populate the usage."
      />
    );
  }
  return (
    <div className="usage-panel-body h-113.5 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={buckets} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
          <defs>
            <linearGradient id="usageChartFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.45} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--inner-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            tickFormatter={(value: string) => formatChartTick(value)}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value: number) => formatTokens(value)}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: "var(--surface-2)",
              border: "1px solid var(--inner-border)",
              borderRadius: 12,
              fontSize: 12,
              color: "var(--text-primary)",
            }}
            formatter={(value) => [formatNumber(Number(value)), metric]}
            labelFormatter={(label) => formatChartTooltip(String(label))}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#usageChartFill)"
            isAnimationActive={!reducedMotion}
            animationDuration={250}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
