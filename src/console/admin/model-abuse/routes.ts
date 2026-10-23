import { Elysia, t } from "elysia";
import { PERMANENT_BAN_TTL_MS, type ModelAbuseBan } from "../../../security/model-abuse";
import { ConsoleDomainError, errorResponse, requireGlobalAdmin } from "../../shared/errors";
import {
  BAN_DURATION_CHOICES,
  DEFAULT_BAN_MINUTES,
  type ModelAbuseRoutesConfig,
} from "./contracts";

const unbanBody = t.Object({
  /** The opaque member the listing reports, so a scoped ban lifts exactly it. */
  identity: t.String({ minLength: 1 }),
});

const banBody = t.Object({
  ip: t.String({ minLength: 1, maxLength: 45 }),
  /**
   * The key this ban is scoped to. Omitted or null is the blunt instrument:
   * every key used from this address. That is a real choice an operator makes
   * when the address is the problem, not a fallback for a missing value — so it
   * is explicit in the body rather than inferred from an empty string.
   */
  apiKeyId: t.Optional(t.Union([t.String({ minLength: 1 }), t.Null()])),
  /** Whole minutes, or null for permanent. Default one hour. */
  minutes: t.Optional(t.Union([t.Number({ minimum: 1 }), t.Null()])),
  /**
   * Bans the address outright, whatever `apiKeyId` says. Kept as its own flag
   * so "no key supplied" cannot quietly widen into "every key" — the two read
   * the same in a body that only had the one field.
   */
  addressOnly: t.Optional(t.Boolean()),
});

/** The durations the route accepts, as whole minutes. `null` is permanent. */
const ALLOWED_MINUTES = new Set<number | null>(
  BAN_DURATION_CHOICES.map((choice) => choice.minutes),
);

/**
 * How long a requested ban lasts, in milliseconds.
 *
 * `null` means permanent, which is a very long TTL rather than an unbounded
 * ban: both stores lapse a ban by comparing an expiry to now, so a genuinely
 * infinite ban would need a second mechanism and a second way to get it wrong.
 *
 * Anything not on the offered list is rejected rather than clamped. Clamping
 * would answer a request for 90 days with a week and report success, and an
 * operator who asked for the longer ban would believe they got it.
 */
function banTtlMs(minutes: number | null | undefined): number {
  const chosen = minutes === undefined ? DEFAULT_BAN_MINUTES : minutes;
  if (!ALLOWED_MINUTES.has(chosen)) {
    throw new ConsoleDomainError(
      "invalid_request",
      400,
      "Unsupported ban duration. Choose one of the offered durations.",
    );
  }
  return chosen === null ? PERMANENT_BAN_TTL_MS : chosen * 60_000;
}

export function createModelAbuseRoutes(config: ModelAbuseRoutesConfig): Elysia {
  return new Elysia()
    .get("/model-bans", async ({ request, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const bans: readonly ModelAbuseBan[] = await config.strikes.listBans();
        return { bans };
      } catch (e) {
        return errorResponse(e, set, "Model ban read failed");
      }
    })
    .post("/model-bans", { body: banBody }, async ({ request, body, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const ban = await config.strikes.ban({
          ip: body.ip,
          ...(body.apiKeyId === undefined ? {} : { apiKeyId: body.apiKeyId }),
          ttlMs: banTtlMs(body.minutes),
          ...(body.addressOnly === undefined ? {} : { addressOnly: body.addressOnly }),
        });
        return { ban };
      } catch (e) {
        return errorResponse(e, set, "Model ban failed");
      }
    })
    .delete("/model-bans", { body: unbanBody }, async ({ request, body, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const removed = await config.strikes.unban(body.identity);
        if (!removed) throw new ConsoleDomainError("ban_not_found", 404, "No such ban");
        return { success: true };
      } catch (e) {
        return errorResponse(e, set, "Model unban failed");
      }
    }) as unknown as Elysia;
}
