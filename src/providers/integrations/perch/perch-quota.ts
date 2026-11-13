// Perch quota collector.
//
// Reads the account's plan/allowance surface from the hosted API
// (`GET /api/perchai/account` with the stored access token). The account
// endpoint reports `planCode`, `planName`, `membershipRole`, usage meters
// (`usageMeter.monthlyUsd`, `roostRolling`), and `tierSelectionRequired`.
// Reads are Bearer-authenticated; never throws — a failed read returns a
// null result so the router treats it as unknown rather than dead.

import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { cleanError, percentWindow, text } from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { quotaUnreadable, readJsonOk } from "../shared/cli-client-kit";
import { PERCH_APP_URL } from "./perch-realm";
import { parsePerchCredentialToken } from "./perch-credential";

const USD_WINDOW_KIND = "usd_monthly";

/** Reads the account quota and returns a normalized result. */
export async function fetchPerchQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const token = parsePerchCredentialToken(credential) ?? "";
    if (!token) {
      return quotaUnreadable("perch", "Perch account endpoint unavailable");
    }
    const account = await readJsonOk(fetcher, `${PERCH_APP_URL}/api/perchai/account`, {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    });
    if (!account) {
      return quotaUnreadable("perch", "Perch account endpoint unavailable");
    }
    const session = account["session"] as Record<string, unknown> | undefined;
    const plan = session && typeof session["planCode"] === "string" ? text(session["planCode"]) : null;
    const meter = account["usageMeter"] as Record<string, unknown> | undefined;
    const windows: ProviderQuotaWindow[] = [];

    const monthlyUsd = meter?.["monthlyUsd"];
    if (typeof monthlyUsd === "number") {
      // Starter includes $20/month of hosted usage; reset at month end.
      const used = monthlyUsd as number;
      const limit = 20;
      windows.push(
        percentWindow(
          USD_WINDOW_KIND,
          "Monthly USD usage",
          used > 0 ? (used / limit) * 100 : 0,
          null,
          used,
          limit,
          "pooled",
        ),
      );
    }

    const roost = meter?.["roostRolling"] as Record<string, unknown> | undefined;
    if (roost && typeof roost["window5hCapUsd"] === "number") {
      const cap = roost["window5hCapUsd"] as number;
      const used = typeof roost["window5hUsd"] === "number" ? (roost["window5hUsd"] as number) : 0;
      windows.push(
        percentWindow(
          "usd_5h",
          "Roost 5-hour rolling",
          cap > 0 ? (used / cap) * 100 : 0,
          null,
          used,
          cap,
          "independent",
        ),
      );
    }
    if (roost && typeof roost["window7dCapUsd"] === "number") {
      const cap = roost["window7dCapUsd"] as number;
      const used = typeof roost["window7dUsd"] === "number" ? (roost["window7dUsd"] as number) : 0;
      windows.push(
        percentWindow(
          "usd_weekly",
          "Roost weekly rolling",
          cap > 0 ? (used / cap) * 100 : 0,
          null,
          used,
          cap,
          "independent",
        ),
      );
    }

    const profile = account["profile"] as Record<string, unknown> | undefined;
    const email = profile && typeof profile["email"] === "string" ? text(profile["email"]) : undefined;

    return {
      source: "perch",
      plan,
      windows,
      error: null,
      ...(email ? { accountLabel: email } : {}),
    };
  } catch (error) {
    return quotaUnreadable("perch", cleanError(error));
  }
}
