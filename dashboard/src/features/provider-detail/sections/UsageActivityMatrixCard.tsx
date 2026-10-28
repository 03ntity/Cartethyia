import { useMemo, useState, type ReactNode } from "react";
import { Activity, ChevronDown } from "lucide-react";
import { Card } from "../../../components/ui/card";
import { cn } from "../../../lib/classnames";
import { formatTokens } from "../../../lib/format/tokens";
import { useProviderUsageMatrix, type ProviderUsageDayRow } from "../../../hooks/providers";
import { formatUsd } from "../../usage/sections/formatters";

/**
 * Collapsible "Activity Matrix" card: a GitHub-contribution-style calendar of
 * the provider's daily token usage over the requested window, with a summary
 * strip and a cursor-following tooltip breaking each day down per model.
 *
 * Closed by default — the aggregate query behind it only fires once the
 * operator expands it, so browsing provider detail costs no telemetry scan.
 */
export function UsageActivityMatrixCard({ providerId }: { readonly providerId: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const matrix = useProviderUsageMatrix(providerId, open);

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((value: boolean) => !value)}
        aria-expanded={open}
        className="card-header-bar w-full cursor-pointer list-none text-left"
      >
        <div className="card-header-left">
          <div className="card-header-icon">
            <Activity size={16} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-text-primary">Activity Matrix</div>
            <div className="text-caption text-text-secondary">
              Daily token usage, last {matrix.data?.days ?? 30} days · expand to load
            </div>
          </div>
        </div>
        <div className="card-header-right">
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cn("transition-transform", open && "rotate-180")}
          />
        </div>
      </button>
      {open ? <UsageMatrixBody matrix={matrix} /> : null}
    </Card>
  );
}

interface DayCell {
  readonly day: string;
  readonly label: string;
  readonly total: number;
  /** Dominant model's own color — what fills the box. */
  readonly color: string;
  readonly models: readonly { readonly name: string; readonly tokens: number; readonly requests: number; readonly color: string }[];
}

interface MatrixWeek {
  readonly cells: readonly (DayCell | null)[];
}

interface MatrixView {
  readonly weeks: readonly MatrixWeek[];
  readonly maxDay: number;
  readonly totals: {
    readonly requests: number;
    readonly tokens: number;
    readonly cachedTokens: number;
    readonly costUsd: number;
  };
  /** Whole-window per-model usage, sorted by tokens — the expandable bar list. */
  readonly models: readonly { readonly name: string; readonly tokens: number; readonly requests: number; readonly color: string }[];
}

function buildMatrixView(data: { readonly days: number; readonly rows: readonly ProviderUsageDayRow[] }): MatrixView {
  const perDay = new Map<string, { tokens: number; models: Map<string, { tokens: number; requests: number }> }>();
  const perModel = new Map<string, { tokens: number; requests: number }>();
  const totals = { requests: 0, tokens: 0, cachedTokens: 0, costUsd: 0 };
  for (const row of data.rows) {
    const day = perDay.get(row.day) ?? { tokens: 0, models: new Map() };
    const tokens = row.inputTokens + row.outputTokens;
    day.tokens += tokens;
    const key = row.model ?? "unknown";
    const model = day.models.get(key) ?? { tokens: 0, requests: 0 };
    model.tokens += tokens;
    model.requests += row.requests;
    day.models.set(key, model);
    perDay.set(row.day, day);
    const windowModel = perModel.get(key) ?? { tokens: 0, requests: 0 };
    windowModel.tokens += tokens;
    windowModel.requests += row.requests;
    perModel.set(key, windowModel);
    totals.requests += row.requests;
    totals.tokens += tokens;
    totals.cachedTokens += row.cachedInputTokens;
    totals.costUsd += row.costUsd;
  }

  // UTC day walk so the grid matches the server's epoch-day buckets exactly;
  // the last day with data is today's bucket.
  const dayCount = Math.min(Math.max(data.days, 1), 366);
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const weeks: MatrixWeek[] = [];
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let maxDay = 0;
  for (const day of perDay.values()) maxDay = Math.max(maxDay, day.tokens);

  // First cell = start of the window's first (partial) Monday-start week.
  const startDate = new Date(todayUtc - (dayCount - 1) * 86_400_000);
  // Back up to Monday of that week so rows align by weekday.
  const lead = (startDate.getUTCDay() + 6) % 7;
  const firstMonday = startDate.getTime() - lead * 86_400_000;

  let cursor = firstMonday;
  let cells: (DayCell | null)[] = [];
  for (;;) {
    if (cursor > todayUtc) {
      // Pad the final row with blanks only if it already carries days; a row
      // that never starts is dropped entirely.
      if (cells.length > 0 || weeks.length === 0) {
        while (cells.length < 7) cells.push(null);
        weeks.push({ cells });
      }
      break;
    }
    const date = new Date(cursor);
    const key = date.toISOString().slice(0, 10);
    const entry = perDay.get(key);
    const modelsOfDay = entry
      ? [...entry.models.entries()]
          .map(([name, value]) => ({ name, tokens: value.tokens, requests: value.requests, color: modelColor(name) }))
          .sort((a, b) => b.tokens - a.tokens)
      : [];
    const cell: DayCell | null = entry
      ? {
          day: key,
          label: `${dow[(date.getUTCDay() + 6) % 7]} ${key.slice(5)}`,
          total: entry.tokens,
          color: modelsOfDay[0]?.color ?? "var(--surface-2)",
          models: modelsOfDay,
        }
      : null;
    cells.push(cell);
    if (cells.length === 7) {
      weeks.push({ cells });
      cells = [];
    }
    cursor += 86_400_000;
  }
  const models = [...perModel.entries()]
    .map(([name, value]) => ({ name, tokens: value.tokens, requests: value.requests, color: modelColor(name) }))
    .sort((a, b) => b.tokens - a.tokens);
  return { weeks, maxDay, totals, models };
}

/**
 * Stable per-model color: hashed hue, so the same model always lands on the
 * same shade and two models rarely collide. Applied to the day's dominant
 * model (the box fill) and to each model's name/dot in the tooltip.
 */
function modelColor(name: string): string {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) hash = (hash * 33) ^ name.charCodeAt(i);
  const hue = Math.abs(hash) % 360;
  // Keep hues out of the muddled 60-110° yellow-green band where the accent
  // teal lives, so a model color never reads as "no data yet".
  const shifted = hue < 60 || hue > 110 ? hue : hue + 130;
  return `hsl(${shifted % 360} 65% 60%)`;
}

function heatLevel(total: number, max: number): number {
  if (total <= 0 || max <= 0) return 0;
  const ratio = total / max;
  let level = 1;
  for (let i = 1; i < HEAT_ALPHA.length; i++) {
    if (ratio > (i / (HEAT_ALPHA.length - 1)) ) level = i;
  }
  return Math.min(level, HEAT_ALPHA.length - 1);
}

const HEAT_ALPHA = [0, 0.18, 0.38, 0.62, 0.9] as const;

/** Alpha step for an intensity level, clamped into the recorded ladder. */
function heatAlpha(level: number): number {
  return HEAT_ALPHA[Math.min(Math.max(Math.trunc(level), 0), HEAT_ALPHA.length - 1)] ?? 0;
}

/** Legend swatch: neutral steps of the foreground at the same intensities. */
function heatSwatch(level: number): string {
  const pct = heatAlpha(level) * 100;
  return pct === 0 ? "var(--surface-2)" : `color-mix(in srgb, var(--text-primary) ${pct}%, transparent)`;
}

function cellStyle(cell: DayCell, level: number): { readonly backgroundColor: string; readonly borderColor: string } {
  if (level === 0) return { backgroundColor: "var(--surface-2)", borderColor: "var(--inner-border)" };
  const tint = heatAlpha(level) * 100;
  return {
    backgroundColor: `color-mix(in srgb, ${cell.color} ${tint}%, transparent)`,
    borderColor: `color-mix(in srgb, ${cell.color} 45%, transparent)`,
  };
}

/** The native `title` hover text: day total, then one line per model. */
function cellTitle(cell: DayCell): string {
  const lines = [
    `${cell.label} — ${formatTokens(cell.total)} tokens`,
    ...cell.models.map((model) =>
      `• ${model.name}: ${formatTokens(model.tokens)} (${Math.round((model.tokens / cell.total) * 100)}%) · ${model.requests} req`,
    ),
  ];
  return lines.join("\n");
}

// Calendar grid constants live here rather than as literals in JSX: the
// ratchet counts a static inline style, so the layout math reads from these.
const CALENDAR_COLUMNS = "26px repeat(7, minmax(0, 1fr))";
const CALENDAR_MAX_WIDTH = 420;
/** Mobile floor below which the grid scrolls horizontally instead. */
const CALENDAR_MIN_WIDTH = 360;

function UsageMatrixBody({
  matrix,
}: {
  readonly matrix: ReturnType<typeof useProviderUsageMatrix>;
}): ReactNode {
  const view = useMemo(
    () => (matrix.data ? buildMatrixView(matrix.data) : undefined),
    [matrix.data],
  );

  let body: ReactNode;
  if (matrix.isPending) {
    body = <p className="p-4 text-caption text-text-secondary">Loading activity…</p>;
  } else if (matrix.isError) {
    body = <p className="p-4 text-caption text-status-danger">Failed to load activity matrix.</p>;
  } else if (!view || view.totals.requests === 0) {
    body = (
      <p className="p-4 text-caption text-text-secondary">
        No usage recorded for this provider in the window.
      </p>
    );
  } else {
    body = <MatrixGrid view={view} />;
  }

  return (
    <>
      <div className="border-t border-inner-border">
        <div className="grid grid-cols-2 gap-4 p-4 max-small:p-3 min-[641px]:grid-cols-4">
          <Metric label="Total tokens" value={formatTokens(view?.totals.tokens)} />
          <Metric label="Requests" value={(view?.totals.requests ?? 0).toLocaleString("en-US")} />
          <Metric label="Cached" value={formatTokens(view?.totals.cachedTokens)} />
          <Metric label="Est. cost" value={formatUsd(view?.totals.costUsd)} />
        </div>
      </div>
      <div className="min-w-0 overflow-x-auto border-t border-inner-border p-4 max-small:p-3">
        {body}
        {view && view.totals.requests > 0 ? (
          <div className="mt-3 flex items-center justify-end gap-1.5 text-micro text-text-tertiary">
            <span>Less</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span
                key={level}
                className="size-3 rounded-micro border border-inner-border"
                style={{ backgroundColor: heatSwatch(level) }}
              />
            ))}
            <span>More</span>
          </div>
        ) : null}
        {view && view.totals.requests > 0 && view.models.length > 0 ? (
          <details className="group mt-4 border-t border-inner-border pt-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-caption text-text-secondary [&::-webkit-details-marker]:hidden">
              <span className="font-semibold">
                Usage by model ({view.models.length}) · sorted by tokens
              </span>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className="shrink-0 transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="mt-3 flex flex-col gap-2.5">
              {view.models.map((model) => {
                const share = view.totals.tokens > 0 ? model.tokens / view.totals.tokens : 0;
                return (
                  <div key={model.name} className="flex min-w-0 items-center gap-3">
                    <span
                      className="min-w-0 shrink truncate text-caption font-semibold"
                      style={{ color: model.color }}
                      title={model.name}
                    >
                      {model.name}
                    </span>
                    <span
                      className="h-2.5 min-w-0 flex-1 rounded-micro"
                      style={{
                        backgroundColor: "var(--surface-2)",
                        backgroundImage: `linear-gradient(to right, ${model.color} ${Math.max(share * 100, 2)}%, transparent ${Math.max(share * 100, 2)}%)`,
                      }}
                    />
                    <span className="shrink-0 font-mono text-caption text-text-secondary">
                      {formatTokens(model.tokens)}{" "}
                      <span className="text-text-tertiary">{Math.round(share * 100)}%</span> ·{" "}
                      {model.requests.toLocaleString("en-US")} req
                    </span>
                  </div>
                );
              })}
            </div>
          </details>
        ) : null}
      </div>
    </>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className="min-w-0">
      <div className="text-micro font-semibold uppercase tracking-label text-text-tertiary">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-bold text-text-primary">{value}</div>
    </div>
  );
}

function MatrixGrid({ view }: { readonly view: MatrixView }): ReactNode {
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div style={{ minWidth: CALENDAR_MIN_WIDTH }}>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: CALENDAR_COLUMNS, maxWidth: CALENDAR_MAX_WIDTH }}
      >
        <div />
        {dow.map((label) => (
          <div key={label} className="text-center text-micro text-text-tertiary">
            {label}
          </div>
        ))}
        {view.weeks.map((week, weekIndex) => (
          <div key={weekIndex} className="contents">
            <div className="flex items-center text-micro text-text-tertiary">W{weekIndex + 1}</div>
            {week.cells.map((cell, cellIndex) =>
              cell === null ? (
                <div key={`${weekIndex}-${cellIndex}`} />
              ) : (
                <div
                  key={cell.day}
                  className="aspect-square cursor-pointer rounded-micro border border-inner-border transition-[outline-offset] hover:outline hover:outline-2 hover:outline-accent"
                  style={cellStyle(cell, heatLevel(cell.total, view.maxDay))}
                  title={cellTitle(cell)}
                />
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
