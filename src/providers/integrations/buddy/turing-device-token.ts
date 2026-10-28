/**
 * TuringShield device-token integration for the buddy providers.
 *
 * WorkBuddy/CodeBuddy desktop clients derive `X-Device-Token` from Tencent's
 * TuringShield SDK (native addon + DLL, channel 400111). The upstream risk
 * control expects that header on chat traffic, and the official desktop app
 * always presents either a real token or an `X-Device-Token-Error` — never
 * neither.
 *
 * The SDK is a proprietary native binary shipped inside this repository under
 * `vendor/turing-sdk/` (extracted from the WorkBuddy desktop app, channel
 * 400111). `CARTETHYIA_TURING_SDK_PATH` remains as an optional override for
 * deployments that bring their own copy. When neither is present the service
 * falls back to the same "sdk_not_initialized" failure state the desktop app
 * emits when the SDK cannot run.
 *
 * Loading and calling the SDK is safe: `configure()` is local-only, and
 * `fetchDeviceToken()` performs the SDK's normal network exchange with the
 * Turing endpoint (the same call the desktop client makes). On platforms
 * without native support (non-win32/darwin) the service degrades to the
 * fallback.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { log } from "../../../observability/logger";
import { resolvePackagePath } from "../../../config/package-paths";

/** Channel assigned to the WorkBuddy desktop product (see cli/product.json). */
export const TURING_CHANNEL_ID = 400111;

/** Per-provider SDK configuration (payload identity sent to Turing). */
export interface TuringSdkConfig {
  readonly channelId: number;
  readonly productName: string;
  readonly productVersion: string;
}

/** Canonical config for the WorkBuddy profile. */
export const WORKBUDDY_TURING_CONFIG: TuringSdkConfig = {
  channelId: TURING_CHANNEL_ID,
  productName: "WorkBuddy AI",
  productVersion: "5.8.4",
};

/** Canonical config for the CodeBuddy profile (same SDK, distinct payload). */
export const CODEBUDDY_TURING_CONFIG: TuringSdkConfig = {
  channelId: TURING_CHANNEL_ID,
  productName: "CodeBuddy",
  productVersion: "4.12.1",
};

/** Mirror the desktop client's service defaults (main-bootstrap.js). */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 30_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const MAX_BACKOFF_LEVEL = 20;

/**
 * Resolve the directory holding the Turing SDK native files, or null.
 *
 * Priority: `CARTETHYIA_TURING_SDK_PATH` override → bundled copy in
 * `vendor/turing-sdk/build/Release/` under the package root (works both in
 * source and in the compiled binary, where `CARTETHYIA_PACKAGE_ROOT` points at
 * `/app`).
 */
export function resolveTuringSdkRoot(): string | null {
  const env = process.env["CARTETHYIA_TURING_SDK_PATH"];
  if (env !== undefined && env.trim().length > 0) return env.trim();
  // Bundled SDK (committed in vendor/).
  const bundled = resolvePackagePath("vendor", "turing-sdk", "build", "Release");
  if (existsSync(path.join(bundled, "turing_sdk.node"))) return bundled;
  return null;
}

/** Pure header decision, matching the desktop app's `token || error` contract. */
export function turingHeadersForRequest(args: {
  token?: string;
  error?: string;
  cliIdentity?: boolean;
}): Record<string, string> {
  if (args.cliIdentity) return {};
  const token = args.token?.trim();
  if (token !== undefined && token.length > 0) return { "x-device-token": token };
  const error = args.error?.trim();
  if (error !== undefined && error.length > 0) return { "x-device-token-error": error };
  return { "x-device-token-error": "sdk_not_initialized" };
}

/** Stable identifier for logs (never the token itself). */
function logDeviceFingerprint(): string {
  const parts = [process.platform, process.arch, process.env["COMPUTERNAME"] ?? process.env["HOSTNAME"] ?? ""];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
}

export class TuringDeviceTokenService {
  private binding: { configure(...a: unknown[]): unknown; fetchDeviceToken(o: unknown): unknown } | null = null;
  private loadAttempted = false;
  private configured = false;

  private cachedToken: string | undefined;
  private cachedError: string | undefined;
  private cachedAt = 0;
  private consecutiveFailures = 0;
  private nextRetryAt = 0;
  private inflight: Promise<string> | undefined;

  constructor(private readonly config: TuringSdkConfig = WORKBUDDY_TURING_CONFIG) {}

  private ensureLoaded(): boolean {
    if (this.loadAttempted) return this.configured;
    this.loadAttempted = true;
    const root = resolveTuringSdkRoot();
    if (root === null) {
      log.warn("[turing-sdk] no SDK root (env unset & vendor missing); device token fallback active");
      return false;
    }
    const nodePath = path.join(root, "turing_sdk.node");
    if (!existsSync(nodePath)) {
      log.warn("[turing-sdk] turing_sdk.node not found at " + nodePath);
      return false;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded: unknown = require(nodePath);
      if (loaded === null || typeof loaded !== "object" || typeof (loaded as Record<string, unknown>)["configure"] !== "function") {
        log.warn("[turing-sdk] native addon loaded but exposes no configure()");
        return false;
      }
      const binding = loaded as NonNullable<TuringDeviceTokenService["binding"]>;
      binding.configure(this.config.channelId, this.config.productName, this.config.productVersion);
      this.binding = binding;
      this.configured = true;
      log.info(
        "[turing-sdk] native SDK configured (channel " + this.config.channelId +
        ", product " + this.config.productName + " " + this.config.productVersion +
        ", " + logDeviceFingerprint() + ")",
      );
    } catch (error) {
      log.warn("[turing-sdk] failed to load/configure native SDK: " + (error instanceof Error ? error.message : String(error)));
      this.binding = null;
    }
    return this.configured;
  }

  /** Returns a real token when the SDK can produce one; undefined otherwise. */
  async fetchDeviceToken(): Promise<string | undefined> {
    if (!this.ensureLoaded()) return undefined;
    const now = Date.now();
    if (this.inflight) return this.inflight;
    const task = this.performFetch().finally(() => {
      this.inflight = undefined;
    });
    this.inflight = task;
    try {
      const token = await task;
      this.cachedToken = token;
      this.cachedError = undefined;
      this.cachedAt = now;
      this.consecutiveFailures = 0;
      this.nextRetryAt = 0;
      return token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cachedError = message.replace(/[^\x20-\x7E]/g, "").slice(0, 64);
      this.consecutiveFailures += 1;
      const level = Math.min(Math.max(0, this.consecutiveFailures - 1), MAX_BACKOFF_LEVEL);
      const delay = Math.min(DEFAULT_RETRY_BASE_DELAY_MS * 2 ** level, DEFAULT_RETRY_MAX_DELAY_MS);
      this.nextRetryAt = Date.now() + delay;
      return undefined;
    }
  }

  private async performFetch(): Promise<string> {
    const binding = this.binding;
    if (!binding) throw new Error("sdk_not_initialized");
    const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
    const promise = binding.fetchDeviceToken({
      usingCachedMessage: true,
      includesOutdatedMessage: false,
      includesDeviceInfo: true,
      timeoutMs,
    });
    const token = await this.withTimeout(Promise.resolve(promise) as Promise<string>, timeoutMs);
    const text = typeof token === "string" ? token : String(token ?? "");
    if (text.trim().length === 0) throw new Error("Turing SDK returned an empty device token");
    return text.trim();
  }

  private async withTimeout(promise: Promise<string>, ms: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Turing SDK device token request timed out after " + ms + "ms")), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Headers for one buddy request. Ensures a cached token exists (refreshing
   * in the background when stale), then returns the desktop `token || error`
   * contract.
   */
  async headersForRequest(cliIdentity?: boolean, requested?: TuringSdkConfig): Promise<Record<string, string>> {
    // The Turing SDK rejects a channelId change after initialization. Keep the
    // first config that actually configures the binding; later conflicting
    // requests are warned once and keep serving the active token.
    if (requested !== undefined) {
      const activeOrMine = this.configured ? this.config : requested;
      if (this.configured && (requested.channelId !== this.config.channelId || requested.productName !== this.config.productName)) {
        log.warn("[turing-sdk] ignoring conflicting SDK config (channel " + requested.channelId + ", " + requested.productName + "); active is channel " + this.config.channelId + ", " + this.config.productName);
      } else {
        void activeOrMine;
      }
    }
    let token: string | undefined = this.cachedToken;
    let error: string | undefined = this.cachedError;
    const now = Date.now();
    if (token === undefined) {
      if (now < this.nextRetryAt) {
        // Keep whatever we had; still within backoff.
      } else {
        token = await this.fetchDeviceToken();
        if (token === undefined) error = this.cachedError;
      }
    } else if (now - this.cachedAt >= DEFAULT_REFRESH_INTERVAL_MS) {
      // Stale: refresh opportunistically but keep serving the cached token.
      void this.fetchDeviceToken();
    }
    return turingHeadersForRequest({
      ...(token === undefined ? {} : { token }),
      ...(error === undefined ? {} : { error }),
      ...(cliIdentity === undefined ? {} : { cliIdentity }),
    });
  }
}

/**
 * Process-wide services keyed by their SDK config (channel/product). Each
 * provider identity gets its own service so its payload (productName,
 * productVersion) is used when the SDK is first configured. The underlying
 * native addon is shared, but configure() runs per instance.
 */
const servicesByConfig = new Map<string, TuringDeviceTokenService>();
export function getTuringDeviceTokenService(
  config: TuringSdkConfig = WORKBUDDY_TURING_CONFIG,
): TuringDeviceTokenService {
  const key = `${config.channelId}:${config.productName}`;
  let service = servicesByConfig.get(key);
  if (service === undefined) {
    service = new TuringDeviceTokenService(config);
    servicesByConfig.set(key, service);
  }
  return service;
}
