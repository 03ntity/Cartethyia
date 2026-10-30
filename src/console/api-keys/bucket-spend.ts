import { eq } from "drizzle-orm";

import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { apiKeys } from "../../persistence/schema";
import { sumTelemetryTokens } from "../../observability/event-query";
import { utcDayStart, utcMonthStart } from "../shared/day";

/**
 * Tokens already recorded for the current daily and monthly admission buckets.
 *
 * The admission counters themselves are transient (Redis keys with a bucket
 * TTL), so when an operator adds a limit to a key that has already spent in the
 * current bucket, there is no counter to read. This reads the durable record —
 * telemetry — instead, which is what the bucket would have contained had the
 * limit existed all along.
 *
 * Buckets are UTC, matching `admission.ts` (`toISOString().slice(0, 10)` /
 * `slice(0, 7)`), so a seeded counter lines up with the one the reserve script
 * would have written.
 *
 * A share template's recipients admit under the parent id, and their spend is
 * attributed to their own child row, so the family is summed — otherwise
 * seeding a template would miss everything its recipients already used. The
 * family is passed to the reader as the template's id, which the query
 * resolves with an `EXISTS` against `api_keys`: a family that has minted tens
 * of thousands of children must not expand them into bind parameters on the
 * key-creation path, which is where an old id-list version crashed the
 * process.
 */
export async function familyBucketSpend(
  db: CartethyiaDatabase,
  keyId: string,
  now: Date,
): Promise<{ daily: number; monthly: number }> {
  // The tenant comes from the key row itself: the caller passes only the key
  // id, and the SQL sums are tenant-scoped so scoping must not be guessed.
  const [parent] = await db
    .select({ tenantId: apiKeys.tenantId })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1);
  const tenantId = parent?.tenantId;
  if (tenantId === undefined) return { daily: 0, monthly: 0 };
  // Two SQL sums instead of reading every event of the family: the bucket
  // spend only needs a total, and this runs on the key-creation path.
  const spentSince = async (start: Date): Promise<number> =>
    sumTelemetryTokens(db, tenantId, { familyKeyId: keyId, since: start });
  const [daily, monthly] = await Promise.all([
    spentSince(utcDayStart(now)),
    spentSince(utcMonthStart(now)),
  ]);
  return { daily, monthly };
}
