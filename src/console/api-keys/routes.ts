// Console API-key domain: HTTP routes.
//
// Owns request validation schemas and route wiring; every handler delegates to
// the operations factory in `./operations`, which owns the domain logic.

import { Elysia, t, type AnyElysia } from "elysia";
import { API_KEY_MODES, API_KEY_MODEL_ACCESS_MODES, API_KEY_CONCURRENCY_SCOPES } from "../../persistence/schema";
import type { ApiKeyConfig } from "./contracts";
import { literalUnion } from "../shared/elysia-schema";
import { consoleErrorHandler, errorResponse } from "../shared/errors";
import { parseRequest } from "./contracts";
import { popupImageBytes } from "./share-popup-image";
import { createKeyOperations } from "./key-operations";
import { createShareOperations } from "./share-operations";
import { pickDefined } from "../shared/object";

/**
 * Composes the tenant-scoped key lifecycle factory: validation, credential
 * rotation, share links, shared-key listing, and ban handling, split across
 * `key-operations.ts` (listing, create/update/delete, ban), `share-operations.ts`
 * (share links, regeneration, shared-key surface), and `family-cache.ts`
 * (family-wide cache/admission invalidation, driven from the first two).
 */
export function createApiKeyOperations(config: ApiKeyConfig) {
  return {
    ...createKeyOperations(config),
    ...createShareOperations(config),
  };
}

const apiKeyBody = t.Object({
  enabled: t.Optional(t.Boolean()),
  label: t.Optional(t.String()),
  keyMode: t.Optional(literalUnion(API_KEY_MODES)),
  scopes: t.Optional(t.Array(t.String())),
  keyPrefix: t.Optional(t.String()),
  key: t.Optional(t.String()),
  // Limit fields accept `null` to clear a previously set limit ("unlimited");
  // `undefined` leaves it unchanged.
  requestsPerMinute: t.Optional(t.Union([t.Number(), t.Null()])),
  dailyTokenLimit: t.Optional(t.Union([t.Number(), t.Null()])),
  monthlyTokenLimit: t.Optional(t.Union([t.Number(), t.Null()])),
  lifetimeTokenBudget: t.Optional(t.Union([t.Number(), t.Null()])),
  maxConcurrentRequests: t.Optional(t.Union([t.Number(), t.Null()])),
  concurrencyScope: t.Optional(literalUnion(API_KEY_CONCURRENCY_SCOPES)),
  modelPrefix: t.Optional(t.String()),
  modelAccessMode: t.Optional(literalUnion(API_KEY_MODEL_ACCESS_MODES)),
  modelList: t.Optional(t.Array(t.String())),
  clientRouterDenylist: t.Optional(t.Array(t.String())),
  notesTitle: t.Optional(t.String()),
  notesSubtitle: t.Optional(t.String()),
  notesBody: t.Optional(t.String()),
  sharePopupEnabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  sharePopupImage: t.Optional(t.Union([t.String({ maxLength: 2_800_000 }), t.Null()])),
  sharePopupTitle: t.Optional(t.Union([t.String({ maxLength: 120 }), t.Null()])),
  sharePopupBody: t.Optional(t.Union([t.String({ maxLength: 1200 }), t.Null()])),
});

/** Full replacement order for the tenant's top-level credential list. */
const reorderKeysBody = t.Object({ keyIds: t.Array(t.String(), { minItems: 1 }) });

const apiKeyShareBody = t.Object({
  expiresAt: t.Optional(t.Union([t.String(), t.Null()])),
  /** Replaces the existing link's token so the previous URL stops resolving. */
  regenerate: t.Optional(t.Boolean()),
});

/**
 * Serializes an intentional `null` payload as the JSON literal.
 *
 * Elysia reads a bare `null` return as "no content" and emits `200` with an
 * empty body and no `content-type`, which a JSON client cannot parse. `null`
 * here is a real answer — "this key has no link yet" — and the response type
 * declares it, so it has to arrive as the bytes `null` rather than as nothing.
 */
function jsonNull(): Response {
  return new Response("null", {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
/** Creates tenant-bound API-key routes with request-local authorization. */
export function createApiKeyRoutes(config: ApiKeyConfig): AnyElysia {
  const factory = createApiKeyOperations(config);
  return new Elysia({ prefix: "/api-keys" })
    .error(consoleErrorHandler("API-key operation failed"))
    .get("/", async ({ request, query }) => {
      const includeChildren = query?.["includeChildren"] === "1" || query?.["includeChildren"] === "true";
      return await factory.listKeys(config.accessResolver(request), includeChildren);
    })
    .get("/banned", async ({ request }) => {
      return await factory.listActiveBannedKeys(config.accessResolver(request));
    })
    .post("/reorder", { body: reorderKeysBody }, async ({ request, body }) => {
      await factory.reorderKeys(config.accessResolver(request), body.keyIds);
      return { success: true };
    })
    .get("/:keyId", async ({ request, params }) => {
      return await factory.getKeyDetail(config.accessResolver(request), params.keyId);
    })
    .get("/:keyId/share-popup-image", async ({ request, params, set }) => {
      try {
        const result = await factory.getSharePopupImage(config.accessResolver(request), params.keyId);
        return new Response(new Blob([popupImageBytes(result.image)], { type: result.mime }), {
          headers: {
            "content-length": String(result.image.byteLength),
            "cache-control": "private, max-age=300",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return errorResponse(error, set, "API key operation failed");
      }
    })
    .get("/:keyId/shares", async ({ request, params }) => {
      return await factory.listShares(config.accessResolver(request), params.keyId);
    })
    .get("/:keyId/shared-keys", async ({ request, params }) => {
      return await factory.listSharedKeys(
        config.accessResolver(request),
        params.keyId,
        new URL(request.url).searchParams,
      );
    })
    .get("/:keyId/shared-keys/:childKeyId/activity", async ({ request, params }) => {
      return await factory.getSharedKeyActivity(
        config.accessResolver(request),
        params.keyId,
        params.childKeyId,
      );
    })
    .post(
      "/:keyId/shared-keys/revoke-scope",
      { body: t.Object({ scope: t.Union([t.Literal("active"), t.Literal("unused")]) }) },
      async ({ request, params, body }) => {
        return await factory.revokeSharedScope(
          config.accessResolver(request),
          params.keyId,
          body.scope,
        );
      },
    )
    .delete("/:keyId/shares/:shareId", async ({ request, params }) => {
      return await factory.revokeShare(
        config.accessResolver(request),
        params.keyId,
        params.shareId,
      );
    })
    .post("/", { body: apiKeyBody }, async ({ request, body, set }) => {
      set.status = 201;
      return await factory.createKey(config.accessResolver(request), parseRequest(body));
    })
    .patch("/:keyId", { body: apiKeyBody }, async ({ request, params, body }) => {
      return await factory.updateKey(
        config.accessResolver(request),
        params.keyId,
        parseRequest(body),
      );
    })
    .delete("/:keyId", async ({ request, params }) => {
      return await factory.deleteKey(config.accessResolver(request), params.keyId);
    })
    .post(
      "/:keyId/ban",
      {
        body: t.Object({
          reason: t.String(),
          // `reasonLabel` is deliberately not accepted: the audit label is
          // derived server-side from `reason` (see `banKey`), so a client
          // cannot author the human-readable audit entry.
          minutes: t.Optional(t.Union([t.Number({ minimum: 1 }), t.Null()])),
        }),
      },
      async ({ request, params, body }) => {
        return await factory.banKey(config.accessResolver(request), params.keyId, body);
      },
    )
    .post("/:keyId/unban", async ({ request, params }) => {
      return await factory.unbanKey(config.accessResolver(request), params.keyId);
    })
    .get("/:keyId/share", async ({ request, params }) => {
      const share = await factory.getShare(config.accessResolver(request), params.keyId, {
        origin: new URL(request.url).origin,
      });
      return share ?? jsonNull();
    })
    .post("/:keyId/share", { body: t.Optional(apiKeyShareBody) }, async ({ request, params, body, set }) => {
      set.status = 201;
      const input = (body ?? {}) as { expiresAt?: string | null; regenerate?: boolean };
      return await factory.shareKey(config.accessResolver(request), params.keyId, {
        ...pickDefined({ expiresAt: input.expiresAt }),
        ...pickDefined({ regenerate: input.regenerate }),
        origin: new URL(request.url).origin,
      });
    })
    .post("/:keyId/reveal", async ({ request, params }) => {
      return await factory.revealKey(config.accessResolver(request), params.keyId);
    })
    .post("/:keyId/regenerate", async ({ request, params }) => {
      return await factory.regenerateKey(config.accessResolver(request), params.keyId, {
        origin: new URL(request.url).origin,
      });
    });
}
