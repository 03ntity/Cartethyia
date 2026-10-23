// Console surface for model-abuse bans: list active bans, ban one, lift one.
//
// The strike layer (security/model-abuse.ts) bans a caller after repeated
// invalid-model requests. A ban lapses on its own after its TTL, and this is
// the escape hatch for lifting one early — a false positive (a shared NAT, a
// client that genuinely mistyped) must be fixable without SQL. It is a
// platform-admin surface: a ban is a security decision and the identity values
// are cross-tenant.
import type { AccessDecision } from "../../../security/access-control";
import type { ModelStrikeService } from "../../../security/model-abuse";

/**
 * The ban durations the console offers, in whole minutes. `null` is the
 * "Permanent" choice.
 *
 * Expressed in minutes rather than milliseconds because that is what an
 * operator picks and what the label says — a millisecond constant here drifts
 * from the copy the moment either changes.
 */
export const BAN_DURATION_CHOICES = [
  { minutes: 60, label: "1 hour" },
  { minutes: 6 * 60, label: "6 hours" },
  { minutes: 12 * 60, label: "12 hours" },
  { minutes: 24 * 60, label: "1 day" },
  { minutes: 7 * 24 * 60, label: "7 days" },
  { minutes: null, label: "Permanent" },
] as const;

/** The duration a bare "ban this user" click uses: the shortest one on offer. */
export const DEFAULT_BAN_MINUTES = 60;

/** Whole minutes the console accepts, or `null` for permanent. */
export type BanDurationMinutes = (typeof BAN_DURATION_CHOICES)[number]["minutes"];

export interface ModelAbuseRoutesConfig {
  readonly strikes: Pick<ModelStrikeService, "listBans" | "unban" | "ban">;
  readonly accessResolver: (request: Request) => AccessDecision | undefined;
}
