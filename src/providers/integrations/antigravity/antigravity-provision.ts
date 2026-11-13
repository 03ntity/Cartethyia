/**
 * Antigravity Cloud Code Assist provisioning: project-id lookup
 * (`loadCodeAssist`), free-tier onboarding (`onboardUser`), and the cached
 * project resolver (`loadAntigravityProject`) that dispatch, quota, and model
 * discovery share.
 *
 * Split out of `antigravity-protocol.ts`, which re-exports this module's
 * public surface so no importer changes. The only imports are the shared
 * client fingerprint (`getAntigravityUserAgent` / `getAntigravityVersion`)
 * from the protocol module — a one-way edge, no cycle.
 */
import { createHash } from "node:crypto";
import { providerBaseUrl } from "../../provider-metadata";
import { isRecord } from "../../../protocol/codecs";
import type { FetchLike } from "../../authentication/oauth-client";
import {
  ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
  getAntigravityUserAgent,
} from "./antigravity-protocol";

// Project-id lookup (`loadCodeAssist`) — best-effort, cached

const projectIdCache = new Map<string, string>();
const PROJECT_ID_CACHE_MAX = 1024;
function boundProjectIdCache(): void {
  while (projectIdCache.size > PROJECT_ID_CACHE_MAX) {
    const oldest = projectIdCache.keys().next().value;
    if (oldest === undefined) break;
    projectIdCache.delete(oldest);
  }
}
const projectIdInflight = new Map<string, Promise<string | undefined>>();

/** Access-token hash → cache key. Never stores the token itself. */
function tokenKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 32);
}

/**
 * Resolves the caller's Cloud Code Assist project id via
 * `POST /v1internal:loadCodeAssist`. Success is cached per access-token
 * hash for the process lifetime; failures return `undefined` and are not
 * cached so a later dispatch retries. Safe to call from both the OAuth
 * exchange path (warm the cache) and the dispatch path (lazy fetch).
 */
export async function loadAntigravityProject(
  accessToken: string,
  options: {
    readonly baseUrl?: string;
    readonly fetcher?: FetchLike;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  const key = tokenKey(accessToken);
  const cached = projectIdCache.get(key);
  if (cached) return cached;
  const inflight = projectIdInflight.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<string | undefined> => {
    const fetcher = options.fetcher ?? fetch;
    const base = (options.baseUrl ?? providerBaseUrl("antigravity")).replace(/\/+$/, "");
    try {
      // Full discovery (loadCodeAssist + free-tier onboarding) rather than a
      // bare lookup: an account that never onboarded has no project, and a
      // project-less dispatch is rejected as "You do not have a valid license
      // of this product". Cached per access-token hash, so this runs once per
      // token; best-effort at dispatch, so a failure just yields undefined.
      return await discoverAntigravityProject(accessToken, {
        baseUrl: base,
        fetcher,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      return undefined;
    } finally {
      projectIdInflight.delete(key);
    }
  })();

  projectIdInflight.set(key, promise);
  return promise;
}

function extractProjectId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const raw = payload["cloudaicompanionProject"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (isRecord(raw) && typeof raw["id"] === "string" && raw["id"].length > 0) {
    return raw["id"];
  }
  return undefined;
}

const FREE_TIER_ID = "free-tier";
const ONBOARD_USER_PATH = "/v1internal:onboardUser";
const ONBOARD_OPERATIONS_PATH = "/v1internal";
const ONBOARD_TIMEOUT_MS = 30_000;
// Reference client (`cloudCodeMainService.js`) polls the operation every
// 500ms (`gXa = 500`).
const ONBOARD_POLL_INTERVAL_MS = 500;

/** Thrown when an account cannot be enrolled in the Antigravity free tier. */
export class AntigravityProvisioningError extends Error {
  override readonly name = "AntigravityProvisioningError";
}

function hasTierField(
  payload: Record<string, unknown>,
  field: "currentTier" | "paidTier",
): boolean {
  return payload[field] !== undefined && payload[field] !== null;
}

function isFreeTierAllowed(payload: Record<string, unknown>): boolean {
  const tiers = payload["allowedTiers"];
  return (
    Array.isArray(tiers) &&
    tiers.some((tier) => isRecord(tier) && tier["id"] === FREE_TIER_ID)
  );
}

function freeTierIneligibility(
  payload: Record<string, unknown>,
): { reason: string; validationUrl?: string } | undefined {
  const tiers = payload["ineligibleTiers"];
  if (!Array.isArray(tiers)) return undefined;
  for (const candidate of tiers) {
    if (!isRecord(candidate) || candidate["tierId"] !== FREE_TIER_ID) continue;
    const reason = candidate["reasonMessage"];
    if (typeof reason !== "string" || reason.length === 0) continue;
    const url = candidate["validationUrl"];
    return {
      reason,
      ...(typeof url === "string" && url.length > 0 ? { validationUrl: url } : {}),
    };
  }
  return undefined;
}

/** Asserts the account may enroll in the free tier, mirroring the native client. */
function assertFreeTierEligible(payload: Record<string, unknown>): void {
  if (isFreeTierAllowed(payload)) return;
  const ineligibility = freeTierIneligibility(payload);
  if (ineligibility === undefined) return;
  throw new AntigravityProvisioningError(
    ineligibility.validationUrl === undefined
      ? ineligibility.reason
      : `${ineligibility.reason}\n${ineligibility.validationUrl}`,
  );
}

/** One authenticated Cloud Code Assist control-plane call. */
async function cloudCodeAssistCall(
  fetcher: FetchLike,
  base: string,
  accessToken: string,
  path: string,
  init: { method: "POST" | "GET"; body?: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${base}${path}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": getAntigravityUserAgent(),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new AntigravityProvisioningError(
      `${path} failed: ${response.status} ${response.statusText}`,
    );
  }
  const payload = (await response.json()) as unknown;
  return isRecord(payload) ? payload : {};
}

/** Reads the account tier, retrying with the resolved project like the native client. */
async function loadCodeAssist(
  fetcher: FetchLike,
  base: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let payload = await cloudCodeAssistCall(
    fetcher,
    base,
    accessToken,
    "/v1internal:loadCodeAssist",
    { method: "POST", body: { metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA } },
    signal,
  );
  const projectId = extractProjectId(payload);
  if (!hasTierField(payload, "paidTier") && projectId !== undefined) {
    payload = await cloudCodeAssistCall(
      fetcher,
      base,
      accessToken,
      "/v1internal:loadCodeAssist",
      {
        method: "POST",
        body: {
          cloudaicompanionProject: projectId,
          metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
        },
      },
      signal,
    );
  }
  return payload;
}

/** Enrolls the account in the Antigravity free tier, polling until it settles. */
async function onboardUser(
  fetcher: FetchLike,
  base: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new AntigravityProvisioningError("onboardUser timed out");
    return left;
  };
  const projectId = extractProjectId(
    await loadCodeAssist(fetcher, base, accessToken, signal),
  );
  let operation = await cloudCodeAssistCall(
    fetcher,
    base,
    accessToken,
    ONBOARD_USER_PATH,
    {
      method: "POST",
      body: {
        tierId: FREE_TIER_ID,
        ...(projectId === undefined ? {} : { cloudaicompanionProject: projectId }),
        metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
      },
    },
    signal,
  );
  for (;;) {
    if (operation["done"] === true) {
      const error = operation["error"];
      if (isRecord(error) && typeof error["message"] === "string") {
        throw new AntigravityProvisioningError(`onboardUser failed: ${error["message"]}`);
      }
      return;
    }
    const name = operation["name"];
    if (typeof name !== "string" || name.length === 0) {
      throw new AntigravityProvisioningError("onboardUser returned an operation without a name");
    }
    const waited = Promise.withResolvers<void>();
    setTimeout(waited.resolve, Math.min(ONBOARD_POLL_INTERVAL_MS, remaining()));
    await waited.promise;
    operation = await cloudCodeAssistCall(
      fetcher,
      base,
      accessToken,
      `${ONBOARD_OPERATIONS_PATH}/${name}`,
      { method: "GET" },
      signal,
    );
  }
}

/**
 * Resolves the caller's Cloud Code Assist project, enrolling the account in
 * the free tier when it has no tier yet — exactly what the native Antigravity
 * client does after login. Without this step a fresh account has no
 * `cloudaicompanionProject`, and both dispatch and quota calls are rejected
 * with "You do not have a valid license of this product".
 *
 * Throws {@link AntigravityProvisioningError} when the account is ineligible
 * or provisioning fails; the login path surfaces that reason to the operator.
 */
export async function discoverAntigravityProject(
  accessToken: string,
  options: {
    readonly baseUrl?: string;
    readonly fetcher?: FetchLike;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const base = (options.baseUrl ?? providerBaseUrl("antigravity")).replace(/\/+$/, "");
  const initial = await loadCodeAssist(fetcher, base, accessToken, options.signal);
  assertFreeTierEligible(initial);
  if (!hasTierField(initial, "currentTier")) {
    await onboardUser(fetcher, base, accessToken, options.signal);
  }
  const refreshed = await loadCodeAssist(fetcher, base, accessToken, options.signal);
  const projectId = extractProjectId(refreshed);
  if (projectId === undefined) {
    throw new AntigravityProvisioningError(
      "loadCodeAssist did not return a cloudaicompanionProject",
    );
  }
  projectIdCache.set(tokenKey(accessToken), projectId);
  boundProjectIdCache();
  return projectId;
}
