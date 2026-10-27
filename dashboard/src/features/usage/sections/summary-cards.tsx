import type { ReactNode } from "react";
import { ArrowUpFromLine, Database, DollarSign } from "lucide-react";
import type { UsageSummaryTotals } from "../../../data/contracts";
import { StatCard } from "../../../components/ui/layout";
import { tokenScaleValue } from "../../../lib/format/tokens";
import { RequestsStatCard } from "./in-flight";
import { TokenScaleSwitch } from "./token-scale-switch";
import { formatUsd } from "./formatters";

/**
 * The top metric row: Requests plus the four summary tiles. Split out because
 * it is a self-contained grid fed by the summary query alone — the only live
 * piece is the Requests tile, which subscribes to the in-flight context.
 */
export function SummaryMetricCards({
  pending,
  summary,
  tokenScale,
  onTokenScaleChange,
}: {
  readonly pending: boolean;
  readonly summary: UsageSummaryTotals | undefined;
  readonly tokenScale: number;
  readonly onTokenScaleChange: (next: number) => void;
}): ReactNode {
  return (
    <div className="metric-grid grid gap-7 w-full min-w-0">
      <RequestsStatCard
        pending={pending}
        requests={summary?.requests}
      />
      <StatCard
        label="Input tokens"
        fit
        value={pending ? "…" : tokenScaleValue(summary?.inputTokens, tokenScale)}
        detail="Prompt tokens"
        tone="accent"
        action={
          <TokenScaleSwitch
            label="Input tokens scale"
            value={summary?.inputTokens}
            scale={tokenScale}
            onChange={onTokenScaleChange}
          />
        }
      />
      <StatCard
        label="Cached tokens"
        fit
        value={pending ? "…" : tokenScaleValue(summary?.cachedTokens, tokenScale)}
        detail={
          pending
            ? "Cache hit rate"
            : `${summary?.cacheHitRate !== undefined ? Math.round(summary.cacheHitRate * 10) / 10 : 0}% cache hit rate`
        }
        tone="purple"
        icon={<Database size={13} />}
        action={
          <TokenScaleSwitch
            label="Cached tokens scale"
            value={summary?.cachedTokens}
            scale={tokenScale}
            onChange={onTokenScaleChange}
          />
        }
      />
      <StatCard
        label="Output tokens"
        fit
        value={pending ? "…" : tokenScaleValue(summary?.outputTokens, tokenScale)}
        detail="Completion tokens"
        icon={<ArrowUpFromLine size={13} />}
        action={
          <TokenScaleSwitch
            label="Output tokens scale"
            value={summary?.outputTokens}
            scale={tokenScale}
            onChange={onTokenScaleChange}
          />
        }
      />
      <StatCard
        label="Est. cost"
        value={pending ? "…" : formatUsd(summary?.estimatedCostUsd)}
        // The figure is always an estimate, never an invoice. When completed
        // rows exist without a persisted price the estimate is a floor, and
        // the caption says so in plain words instead of naming the flag.
        detail="Estimated not billing"
        tone="orange"
        icon={<DollarSign size={13} />}
      />
    </div>
  );
}
