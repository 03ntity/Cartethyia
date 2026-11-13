// Console OAuth login domain: facade over `account-store.ts` (identity
// fingerprinting and account persistence) and `operations.ts` (exchange,
// device flows, credential import, and route wiring). Keeps the public import
// surface stable for `domain-registration.ts` and the OAuth tests.

import { Elysia, t, type AnyElysia } from "elysia";
import { consoleErrorHandler } from "../../shared/errors";
import {
  createOAuthLoginOperations,
  failurePage,
  type OAuthLoginConfig,
} from "./operations";

export {
  oauthIdentityFingerprint,
  nextGeneratedOAuthAccountLabel,
  isGeneratedOAuthLabel,
  DrizzleOAuthAccountStore,
  type OAuthAccountStore,
} from "./account-store";
export { completeLogin, type OAuthLoginConfig } from "./operations";


const startBody = t.Optional(
  t.Object({
    accountLabel: t.Optional(t.String()),
    /**
     * Provider-specific start inputs the dashboard collected, such as the
     * organization URL or region for a device flow. Providers that need none
     * ignore the field.
     */
    parameters: t.Optional(t.Record(t.String(), t.String())),
  }),
);
const devicePollBody = t.Object({ deviceAuthId: t.String() });
const importBody = t.Object({
  /** The pasted credential material: a token, a key, or an exported auth blob. */
  credential: t.String(),
  /** Values for the fields the provider declared under `oauthFlows.importFields`. */
  fields: t.Optional(t.Record(t.String(), t.String())),
  accountLabel: t.Optional(t.String()),
});

export function createOAuthLoginRoutes(config: OAuthLoginConfig): AnyElysia {
  const factory = createOAuthLoginOperations(config);
  return new Elysia({ prefix: "/providers" })
    .error(consoleErrorHandler("OAuth login operation failed", { detailsPolicy: "always-include" }))
    .post(
      "/:providerId/oauth/authorize",
      { body: startBody },
      async ({ request, params, body, set }) => {
        set.status = 201;
        return await factory.beginAuthorize(
          config.accessResolver(request),
          params.providerId,
          body?.accountLabel ?? params.providerId,
          body?.parameters,
        );
      },
    )
    .get("/:providerId/oauth/callback", async ({ params, query, request }) => {
      const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
      const code = typeof query["code"] === "string" ? query["code"] : "";
      const state = typeof query["state"] === "string" ? query["state"] : "";
      const providerError = typeof query["error"] === "string" ? query["error"] : "";
      if (providerError && state)
        return factory.handleCallbackError(params.providerId, state, wantsJson);
      if (!code) return failurePage("missing code", wantsJson);
      // `state` is absent for authorization servers that do not echo it
      // (OpenRouter). The flow is then correlated by provider instead — one
      // browser login is in flight per provider at a time.
      const loginOption = typeof query["login_option"] === "string" ? query["login_option"] : undefined;
      return factory.handleCallback(
        params.providerId,
        code,
        state,
        wantsJson,
        loginOption === undefined ? undefined : { login_option: loginOption },
      );
    })
    .post(
      "/:providerId/oauth/device/start",
      { body: startBody },
      async ({ request, params, body, set }) => {
        set.status = 201;
        return await factory.startDevice(
          config.accessResolver(request),
          params.providerId,
          body?.accountLabel ?? params.providerId,
          body?.parameters,
        );
      },
    )
    .post(
      "/:providerId/oauth/device/poll",
      { body: devicePollBody },
      async ({ request, params, body }) => {
        return await factory.pollDevice(
          config.accessResolver(request),
          params.providerId,
          body.deviceAuthId,
        );
      },
    )
    .post(
      "/:providerId/oauth/import",
      { body: importBody },
      async ({ request, params, body, set }) => {
        set.status = 201;
        return await factory.importCredential(
          config.accessResolver(request),
          params.providerId,
          body.accountLabel ?? params.providerId,
          body.credential,
          body.fields ?? {},
        );
      },
    )
}
