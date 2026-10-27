import {
  USAGE_PERIODS,
  type UsagePeriod as Period,
} from "../../../data/usage-periods";
import {
  USAGE_DIMENSIONS,
  type UsageDimension,
  type UsageSummaryTotals,
} from "../../../data/contracts";
import {
  DEFAULT_TOKEN_SCALE,
  RAW_TOKEN_SCALE,
  TOKEN_SCALE_AUTO,
  formatTokens,
} from "../../../lib/format/tokens";
import {
  formatCredits,
  formatDuration,
  formatNumber,
} from "../../../lib/format/numbers";
import { periodLabel } from "./period-selector";
import type { Metric } from "./chart-panel";

/** Mirrors the backend `USAGE_DIMENSIONS`; keep in sync by hand. */
type Dimension = UsageDimension;

/**
 * The card headline. The period alone read as a label with nothing under it,
 * so it carries what moved in the period: how many calls, how many tokens,
 * and how long a call took on average.
 */
export function usageHeadline(
  period: Period,
  pending: boolean,
  totals: UsageSummaryTotals | undefined,
): string {
  const label = periodLabel(period);
  if (pending || totals === undefined) return label;
  const tokens = totals.inputTokens + totals.outputTokens;
  return `${label} · ${formatNumber(totals.requests)} calls · ${formatTokens(tokens)} tokens · avg ${formatDuration(totals.avgDurationMs)}`;
}

export function asPeriod(value: string | null): Period {
  return value !== null && (USAGE_PERIODS as readonly string[]).includes(value)
    ? (value as Period)
    : "24h";
}

export function asMetric(value: string | null): Metric {
  return value === "tokens" || value === "cached" ? value : "requests";
}
/**
 * Resolves the card scale. No `scale` param means the exact count (the
 * default); `scale=auto` asks for the compact unit the value lands on; a
 * number pins one of `TOKEN_SCALES`.
 */
export function asTokenScale(value: string | null): number {
  if (value === null) return DEFAULT_TOKEN_SCALE;
  if (value === "auto") return TOKEN_SCALE_AUTO;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= RAW_TOKEN_SCALE ? parsed : DEFAULT_TOKEN_SCALE;
}

export function asDimension(value: string | null): Dimension {
  return value !== null && (USAGE_DIMENSIONS as readonly string[]).includes(value)
    ? (value as Dimension)
    : "model";
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
/**
 * Provider-billed credits (Tencent buddy-meter `credit`) with the unit label:
 * two decimals like the live probe reported (`1.01`), `—` when the upstream
 * sent no credit. The numeric formatting delegates to the shared
 * `formatCredits`, so this page and the provider-detail credit pool round the
 * same way; only the ` CR` suffix is local here.
 */
export function formatCredit(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${formatCredits(value)} CR`;
}
export function formatSpeed(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "—";
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("en-US")} tok/s`;
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Wire surface mapped to its protocol family name for the status cell.
 * The `API KEY` column already identifies the client, so the status cell
 * names only the protocol family — never the endpoint or client string.
 */
export function surfaceFamilyLabel(surface: string | undefined): string {
  switch (surface) {
    case "chat":
      return "OpenAI Completions";
    case "messages":
      return "Anthropic Messages";
    case "responses":
      return "OpenAI Responses";
    case "completion":
      return "OpenAI Completions";
    default:
      return surface ? surface : "—";
  }
}

/**
 * Relative age of a request start for the time cell's second line:
 * minutes below an hour, hours below a day, days below a week, weeks above.
 * Pure display — the absolute clock stays on the first line.
 */
export function formatAgo(value: string, nowMs: number = Date.now()): string {
  const started = new Date(value).getTime();
  if (Number.isNaN(started)) return "—";
  const diffMs = Math.max(0, nowMs - started);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diffMs < hour) {
    const minutes = Math.max(0, Math.floor(diffMs / minute));
    return minutes <= 1 ? "just now" : `${minutes}m ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return hours <= 1 ? "1h ago" : `${hours}h ago`;
  }
  if (diffMs < week) {
    const days = Math.floor(diffMs / day);
    return days <= 1 ? "1d ago" : `${days}d ago`;
  }
  const weeks = Math.floor(diffMs / week);
  return weeks <= 1 ? "1w ago" : `${weeks}w ago`;
}
