import { sha256Hex } from "../../../shared/hash";
import { TtlCache } from "../../../persistence/ttl-cache";
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { authCredential, getJson, percentWindow, record, text, number } from "../../quota/quota-contracts";
import { parseQuotaWindows } from "../../quota/quota-window-parser";
import { parseLimitWindows } from "../../quota/quota-limit-windows";
import { CLAUDE_CODE_OAUTH_QUOTA_BETAS } from "./claude-credentials";
import { CLAUDE_CODE_USER_AGENT } from "./claude-fingerprint";

/** Fixed per-key windows Claude reports alongside the dynamic `limits` array. */
const CLAUDE_FIXED_WINDOWS: readonly {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
}[] = [
  { key: "five_hour", kind: "session", label: "5 Hour" },
  { key: "seven_day", kind: "weekly", label: "7 Day" },
  { key: "seven_day_opus", kind: "weekly_opus", label: "7 Day (Opus)" },
  { key: "seven_day_sonnet", kind: "weekly_sonnet", label: "7 Day (Sonnet)" },
];

/** Display-kind fallback for generic limit scopes the API may report. */
const LIMIT_SCOPE_LABELS: Readonly<Record<string, string>> = {
  session: "5 Hour",
  weekly_all: "7 Day",
};

/** Parses the dynamic `limits` array (per-model weekly windows). */
function limitsWindows(payload: unknown): readonly ProviderQuotaWindow[] {
  const windows: ProviderQuotaWindow[] = [
    ...parseLimitWindows(payload, {
      kindPaths: ["kind"],
      percentPaths: ["percent", "utilization"],
      resetPaths: ["resets_at"],
      labelFor: (kind, limit) => {
        const displayName = text(record(record(limit.scope)?.model)?.display_name);
        const scoped = LIMIT_SCOPE_LABELS[kind];
        if (scoped === undefined) {
          return displayName ? `7 Day (${displayName})` : null;
        }
        return displayName ? `${scoped} (${displayName})` : scoped;
      },
      fallbackLabel: (kind) => kind.replace(/_/g, " "),
    }),
  ];
  // Usage spend in absolute dollars, when the API reports it alongside (or
  // instead of) percentage windows.
  const spend = number(record(payload)?.spend) ?? number(record(payload)?.extra_usage);
  const spendLimit =
    number(record(payload)?.spend_limit) ?? number(record(payload)?.extra_usage_limit);
  if (spend !== null) {
    windows.push(
      percentWindow(
        "spend",
        "Spend (USD)",
        spendLimit !== null && spendLimit > 0 ? (spend / spendLimit) * 100 : null,
        null,
        spend,
        spendLimit,
        "independent",
      ),
    );
  }
  return windows;
}

function parseClaudeQuota(body: unknown): ProviderQuotaResult {
  return parseQuotaWindows(
    body,
    CLAUDE_FIXED_WINDOWS.map(({ key, kind, label }) => ({
      kind,
      label,
      usedPercentPaths: [
        [key, "utilization"],
        [key, "percent"],
      ],
      resetPaths: [[key, "resets_at"]],
      emitWithoutPercent: true,
    })),
    {
      source: "claude",
      planPaths: [["plan_type"], ["plan"]],
      transform: (value) => record(value) ?? {},
      extraWindows: limitsWindows,
    },
  );
}

export async function fetchClaudeQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  // No module-local quota cache: the shared two-tier quota cache owns
  // cross-call dedup, and a local tier keyed by credential only is never
  // invalidated by `debitCachedQuota`, so a sweep within its TTL could
  // resurrect a spent balance over the shared cache. Every call here is a
  // fresh upstream read; the shared cache's in-flight dedup prevents
  // duplicate traffic.
  const key = sha256Hex(credential);
  if (quotaCooldown.get(key) !== undefined) {
    throw new Error("Quota endpoint rejected request: rate limited (cooled down)");
  }
  const access = text(authCredential(credential).accessToken) ?? credential;
  let lastStatus = 0;
  const observing: FetchLike = (async (url, init) => {
    const response = await fetcher(url, init);
    lastStatus = response.status;
    return response;
  }) as FetchLike;
  try {
    const body = await getJson(
      "https://api.anthropic.com/api/oauth/usage",
      {
        authorization: `Bearer ${access}`,
        "anthropic-beta": CLAUDE_CODE_OAUTH_QUOTA_BETAS.join(","),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
        "user-agent": CLAUDE_CODE_USER_AGENT,
        accept: "application/json, text/plain, */*",
        "accept-encoding": "gzip, compress, deflate, br",
        connection: "keep-alive",
      },
      observing,
    );
    return parseClaudeQuota(body);
  } catch (error: unknown) {
    // Hammering the usage endpoint on every call is its own rate-limit
    // risk: back off briefly after a 429 instead of retrying into it.
    if (lastStatus === 429) quotaCooldown.set(key, true);
    throw error;
  }
}

/**
 * Short 429 cooldown (3 min). Keys are credential hashes, never raw secrets;
 * capped so credential fan-out cannot pin memory.
 *
 * The cooldown is an absolute window (`until = now + QUOTA_COOLDOWN_MS`), not a
 * TTL from read time, so it is a sentinel whose own TTL *is* that window: the
 * entry lives for exactly the cooldown and is gone the moment it closes.
 */
const QUOTA_COOLDOWN_MS = 3 * 60_000;
const QUOTA_COOLDOWN_MAX_ENTRIES = 256;
const quotaCooldown = new TtlCache<true>({
  ttlMs: QUOTA_COOLDOWN_MS,
  maxEntries: QUOTA_COOLDOWN_MAX_ENTRIES,
});
