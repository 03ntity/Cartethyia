import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cog,
  Coins,
  Database,
  DollarSign,
  LogIn,
  Route,
  Server,
} from "lucide-react";
import type { UsageRequestItem } from "../../../data/contracts";
import { formatDuration, formatNumber } from "../../../lib/format/numbers";
import { requestProviderId } from "../request-provider";
import { maskClientIp, usageApiKeyLabel, usageClientLabel } from "../usage-labels";
import {
  formatAgo,
  formatCredit,
  formatSpeed,
  formatTime,
  formatUsd,
  surfaceFamilyLabel,
} from "./formatters";
import { StatusCodeWithExplainer } from "./status";

/**
 * The four payload stages, in the order the detail drawer shows them.
 *
 * One bit each, matching the `stages` bitmask the payload row carries: a stage
 * is accented when its body was captured and greyed when it was not. That
 * distinction is the point — a request that failed before reaching the
 * upstream has no provider response, and an operator should see that on the
 * row instead of opening four blank panels to find out.
 */
const CAPTURE_STAGES = [
  { key: "request", bit: 1, label: "Client request", icon: LogIn },
  { key: "providerRequest", bit: 2, label: "Provider request", icon: Route },
  { key: "providerResponse", bit: 4, label: "Provider response", icon: Server },
  { key: "clientResponse", bit: 8, label: "Client response", icon: CheckCircle2 },
] as const;

/**
 * Latency bar above the Requests table.
 *
 * Routing-average lives here (not in the top metric row) because the P50/P95/
 * P99 chips overflowed their grid cell at narrow widths. A flex-wrap row
 * inside the table's rounded panel gives the chips the horizontal room they
 * need and keeps the per-request table right beside the figures that
 * summarise it. Hidden while the summary is still loading so the panel does
 * not flash a "—" row before real numbers arrive.
 *
 * One row, four figures of the same size: `RESOLVE 367 ms · P50 … · P95 … ·
 * P99 …`. "Resolve" names the measurement: a larger label such as "Route
 * latency AVG" reads as a heading sitting on top of the percentiles, and
 * "Latency" puts it in the same series as the percentiles beside it when it is
 * a different measurement entirely (pre-dispatch delay, not response time).
 * It wraps rather than overflows when there is no room.
 *
 * Each figure carries a native `title` explaining the metric, the window, and
 * how many requests it was computed from — a percentile over twenty requests
 * and one over twenty thousand do not deserve the same confidence.
 *
 * It sits outside `DataTable`'s own scroll box, so it stays put while the
 * rows scroll under it.
 */
export function RoutingLatencyBar({
  pending,
  avgMs,
  p50Ms,
  p95Ms,
  p99Ms,
  latencySampleCount,
  resolveSampleCount,
  periodLabel: windowLabel,
}: {
  readonly pending: boolean;
  readonly avgMs: number | undefined;
  readonly p50Ms: number | undefined;
  readonly p95Ms: number | undefined;
  readonly p99Ms: number | undefined;
  readonly latencySampleCount: number | undefined;
  readonly resolveSampleCount: number | undefined;
  readonly periodLabel: string;
}): ReactNode {
  // The summary is shared across the whole page; treat the first paint the
  // same way the top tiles do (a "…") so a long load reads as one state,
  // not a mix of numbers and placeholders.
  if (pending) return null;

  // The first tile is the pre-dispatch delay, not end-to-end latency —
  // labelling it "Latency" put it in the same series as the percentiles
  // beside it, and the two were read as one metric.
  const resolveTitle =
    `Resolve — average time from request arrival to just before the upstream is called ` +
    `(credential, admission, pool slot, preparation). Not response latency. ` +
    `${windowLabel} · ${formatNumber(resolveSampleCount ?? 0)} requests with a resolve measurement.`;
  const percentileTitle = (name: string, percentile: string): string =>
    `${name} — the ${percentile} of total request duration (arrival to final byte), nearest rank. ` +
    `${windowLabel} · from ${formatNumber(latencySampleCount ?? 0)} requests.`;

  const tiles: ReadonlyArray<{
    readonly label: string;
    readonly value: number | undefined;
    readonly title: string;
  }> = [
    { label: "Resolve", value: avgMs, title: resolveTitle },
    { label: "P50", value: p50Ms, title: percentileTitle("P50", "median") },
    { label: "P95", value: p95Ms, title: percentileTitle("P95", "95th percentile") },
    { label: "P99", value: p99Ms, title: percentileTitle("P99", "99th percentile") },
  ];

  return (
    <div
      role="group"
      aria-label="Routing latency summary"
      className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-inner-border px-6 py-5 text-badge"
    >
      <Route size={12} aria-hidden="true" className="shrink-0 text-text-secondary" />
      {tiles.map((tile) => (
        <span
          key={tile.label}
          // Native title, matching the other hover hints on this page: the
          // explanation costs no space until asked for.
          title={tile.title}
          className="inline-flex items-baseline gap-1.5 font-mono tabular-nums leading-none text-caption"
        >
          <span className="font-semibold tracking-label uppercase text-text-tertiary">
            {tile.label}
          </span>
          <span className="font-semibold text-text-secondary">
            {formatDuration(tile.value)}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * One row of the Requests table. Split out because the cell markup is heavy
 * and the row is rendered per request; the table shell (headers, sorting,
 * scrolling) stays in the page.
 */
export function RequestRow({
  row,
  hideProviderName,
  maskIpEnabled,
  providerNames,
  isNew,
  onSelect,
}: {
  readonly row: UsageRequestItem;
  readonly hideProviderName: boolean;
  readonly maskIpEnabled: boolean;
  readonly providerNames: ReadonlyMap<string, string>;
  readonly isNew: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const costText = row.estimatedCost === undefined ? "—" : formatUsd(row.estimatedCost);
  // A request that failed before a candidate was leased has no
  // serving provider, but the caller's qualified model ref still
  // names one, so the column stays populated either way.
  const rowProviderId = requestProviderId(row.providerId, row.model);
  return (
    <tr
      onClick={onSelect}
      className="cursor-pointer transition-colors"
      style={{
        background: isNew ? "color-mix(in srgb, var(--accent) 14%, transparent)" : undefined,
      }}
    >
      <td className="text-badge text-text-tertiary whitespace-nowrap">
        <div>{formatTime(row.startedAt)}</div>
        <div className="text-micro mt-0.5">{formatAgo(row.startedAt)}</div>
      </td>
      <td className="max-w-105">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="truncate text-caption font-semibold"
            title={rowProviderId ?? "—"}
          >
            {hideProviderName ? "Mysterious" : rowProviderId ? (providerNames.get(rowProviderId) ?? rowProviderId) : "—"}
          </span>
        </div>
        <div className="truncate font-mono text-badge text-text-tertiary mt-px" title={row.model ?? "—"}>
          {hideProviderName && row.model && row.model.includes("/")
            ? row.model.slice(row.model.indexOf("/") + 1)
            : row.model ?? "—"}
        </div>
        {row.reportedModel ? (
          // Verbatim, exactly as the upstream wrote it: no prefix
          // stripping, no comparison. A provider answering with a
          // different model than the one asked for is the finding,
          // and normalising it would erase the only evidence.
          <div
            className="flex items-center gap-1.5 mt-px min-w-0 text-micro text-text-tertiary"
            title={`Reported by upstream: ${row.reportedModel}`}
          >
            <Cog size={10} aria-hidden="true" className="shrink-0" />
            <span className="truncate font-mono">{row.reportedModel}</span>
          </div>
        ) : null}
      </td>
      <td className="max-w-70">
        <div
          className="truncate text-caption font-semibold"
          title={usageApiKeyLabel(row)}
        >
          {usageApiKeyLabel(row)}
        </div>
        <div className="truncate font-mono text-badge text-text-tertiary mt-px" title={usageClientLabel(row)}>
          {usageClientLabel(row)}
        </div>
        {/* The caller's address, one line under the client identity.
            Masked by the same switch as the proxy page's egress
            IPs, so one privacy decision covers both surfaces. */}
        <div
          className="truncate font-mono text-badge text-text-tertiary mt-px"
          title={maskIpEnabled && row.clientIp ? "Client IP masked" : row.clientIp ?? "—"}
        >
          {row.clientIp
            ? (maskIpEnabled ? maskClientIp(row.clientIp) : row.clientIp)
            : "—"}
        </div>
      </td>
      <td className="whitespace-nowrap text-badge">
        <div>
          <span
            className="font-mono tabular-nums inline-block min-w-[13ch] text-text-secondary"
          >
            {row.mode === "stream" ? "streaming" : "non-streaming"}
          </span>
          {" "}
          <StatusCodeWithExplainer
            status={row.status}
            errorKind={row.errorKind}
            httpStatus={row.httpStatus}
          />
        </div>
        <div className="flex items-center gap-2.5 mt-px" aria-label="Captured payload stages">
          {CAPTURE_STAGES.map(({ key, bit, label, icon: Icon }) => {
            const captured = row.payloadStages !== undefined && (row.payloadStages & bit) !== 0;
            return (
              <span
                key={key}
                title={captured ? `${label} · captured` : `${label} · not captured`}
                className={captured ? "text-accent" : "text-text-tertiary opacity-45"}
              >
                <Icon size={11} aria-hidden="true" />
              </span>
            );
          })}
        </div>
        <div className="truncate font-mono text-badge text-text-tertiary mt-px max-w-110" title={surfaceFamilyLabel(row.surface)}>
          {surfaceFamilyLabel(row.surface)}
        </div>
      </td>
      <td className="font-mono text-badge whitespace-nowrap text-right tabular-nums">
        <div className="flex gap-6 justify-end">
          <span className="inline-flex items-center gap-2 text-text-secondary">
            <ArrowUp size={10} aria-label="Input tokens" /> IN {formatNumber(row.inputTokens)}
          </span>
          <span className="inline-flex items-center gap-2 text-text-secondary">
            <ArrowDown size={10} aria-label="Output tokens" /> OUT {formatNumber(row.outputTokens)}
          </span>
        </div>
        <div
          className="flex gap-6 justify-end mt-0.5 text-text-tertiary"
          title={row.estimatedCost === undefined ? "Unpriced model — no catalog rate" : undefined}
        >
          <span className="inline-flex items-center gap-2">
            <Database size={10} aria-label="Cached tokens" /> CACHED {formatNumber(row.cachedTokens ?? 0)}
          </span>
          <span className="inline-flex items-center gap-2">
            <DollarSign size={10} aria-label="Estimated cost" /> COST {costText}
          </span>
          {row.creditUsed !== undefined ? (
            <span
              className="inline-flex items-center gap-2"
              title="Provider-billed credits for this turn"
            >
              <Coins size={10} aria-label="Credits used" /> {formatCredit(row.creditUsed)}
            </span>
          ) : null}
        </div>
      </td>
      <td className="font-mono text-caption text-right text-text-secondary whitespace-nowrap">
        {formatSpeed(row.tokensPerSec)}
      </td>
      <td className="font-mono text-caption text-right text-text-secondary">
        <div>{formatDuration(row.ttfbMs)}</div>
        {row.resolveMs !== undefined ? (
          <div
            className="text-micro mt-0.5 text-text-tertiary"
            title="Gateway-side time before the upstream dispatch began"
          >
            ({formatDuration(row.resolveMs)})
          </div>
        ) : null}
      </td>
      <td className="font-mono text-caption text-right text-text-secondary">
        {formatDuration(row.durationMs)}
      </td>
    </tr>
  );
}
