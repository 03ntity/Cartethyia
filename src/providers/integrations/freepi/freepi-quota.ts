// Free-pi quota collector.
//
// Reads `GET /me` (Bearer) — the backend's account/allowance surface. The
// response carries the USD budget (`cap_usd_today`, `remaining_usd_today`),
// credit counts (`allowance_credits`, `remaining_credits_today`,
// `bonus_wallet_credits`, `premium_credits`, …), a `refill_at` reset time, and
// a usage lane (`standard`/`fallback`/`wait`). Never throws: a failed read
// returns a null-result so the router treats it as unknown rather than dead.

import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { cleanError, percentWindow, text } from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { quotaUnreadable, readJsonOk } from "../shared/cli-client-kit";
import { buildFreepiHeaders } from "./freepi-protocol";
import { FREEPI_BASE_URL } from "./freepi-realm";

/** Reads the account quota and returns a normalized result. */
export async function fetchFreepiQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const me = await readJsonOk(fetcher, new URL("/me", FREEPI_BASE_URL), buildFreepiHeaders(credential));
    if (!me) {
      return quotaUnreadable("freepi", "free-pi /me unavailable");
    }
    const plan = me["tier"] === undefined ? null : text(me["tier"]);
    const windows: ProviderQuotaWindow[] = [];

    const capUsd = me["cap_usd_today"];
    const remainingUsd = me["remaining_usd_today"];
    const refillAt = me["refill_at"];
    if (typeof capUsd === "number" && typeof remainingUsd === "number") {
      const limit = capUsd as number;
      const remaining = remainingUsd as number;
      const used = limit - remaining;
      windows.push(
        percentWindow(
          "usd_daily",
          "Daily USD budget",
          used > 0 && limit > 0 ? (used / limit) * 100 : 0,
          refillAt === undefined ? null : text(refillAt),
          used,
          limit,
          "pooled",
        ),
      );
    }

    const allowance = me["allowance_credits"];
    const remainingCredits = me["remaining_credits_today"];
    if (typeof allowance === "number" && typeof remainingCredits === "number") {
      const limit = allowance as number;
      const remaining = remainingCredits as number;
      const used = limit - remaining;
      windows.push(
        percentWindow(
          "credits_daily",
          "Daily credits",
          used > 0 && limit > 0 ? (used / limit) * 100 : 0,
          refillAt === undefined ? null : text(refillAt),
          used,
          limit,
          "pooled",
        ),
      );
    }

    const bonus = me["bonus_wallet_credits"];
    if (typeof bonus === "number") {
      windows.push({
        kind: "bonus_credits",
        label: "Bonus credits",
        accounting: "pooled",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        remaining: bonus as number,
      });
    }

    const premium = me["premium_credits"];
    if (typeof premium === "number") {
      windows.push({
        kind: "premium_credits",
        label: "Premium credits",
        accounting: "pooled",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        remaining: premium as number,
      });
    }

    const handle = me["handle"];
    return {
      source: "freepi",
      plan,
      windows,
      error: null,
      ...(typeof handle === "string" && handle.trim() ? { accountLabel: handle } : {}),
    };
  } catch (error) {
    return quotaUnreadable("freepi", cleanError(error));
  }
}
