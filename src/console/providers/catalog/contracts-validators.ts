// Catalog contract guards and the compatibility-profile validator shared by
// the catalog routes and the Drizzle catalog store. The GatewayError strings
// are part of the console API surface; keep them stable.

import { GatewayError } from "../../../protocol/gateway-error";
import { type ServiceKind, type WireFamily, SERVICE_KINDS, WIRE_FAMILIES } from "../../../protocol/canonical-model";
import type { CompatibilityProfile } from "../../../providers/provider-metadata";
import { isProtectedHeader } from "../../../security/outbound-headers";

const VALID_WIRE_FAMILIES: Record<WireFamily, true> = {
  chat: true,
  responses: true,
  messages: true,
  gemini: true,
};

export function isWireFamily(value: unknown): value is WireFamily {
  return typeof value === "string" && value in VALID_WIRE_FAMILIES;
}

/**
 * Compile-time guard: `VALID_WIRE_FAMILIES` above must cover `WIRE_FAMILIES`
 * exactly, so adding a family to the canonical tuple cannot leave the
 * validator silently rejecting it.
 */
const _wireFamilyCoverage: Record<(typeof WIRE_FAMILIES)[number], true> = VALID_WIRE_FAMILIES;
void _wireFamilyCoverage;

const VALID_SERVICE_KINDS: Record<ServiceKind, true> = {
  llm: true,
  systemone: true,
  websearch: true,
  imageGeneration: true,
  videoGeneration: true,
  embedding: true,
  audioTranscription: true,
  audioSpeech: true,
};

export function isServiceKind(value: unknown): value is ServiceKind {
  return typeof value === "string" && value in VALID_SERVICE_KINDS;
}

/**
 * Compile-time guard: `VALID_SERVICE_KINDS` above must cover `SERVICE_KINDS`
 * exactly, so adding a kind to the canonical tuple cannot leave the validator
 * silently rejecting it.
 */
const _serviceKindCoverage: Record<(typeof SERVICE_KINDS)[number], true> = VALID_SERVICE_KINDS;
void _serviceKindCoverage;

const TOKEN_REGEX = /^[a-z0-9!#$%&'*+\-.^_`|~]+$/;

const ADAPTER_OWNED: Record<string, true> = {
  "x-stainless-arch": true,
  "x-stainless-os": true,
  "x-account-id": true,
  "x-device-id": true,
  "x-session-id": true,
  "anthropic-version": true,
  "anthropic-beta": true,
  "x-app": true,
  originator: true,
  "chatgpt-account-id": true,
  "openai-beta": true,
};

export function validateCompatibilityProfile(profile: CompatibilityProfile): void {
  if (profile.service_kinds !== undefined) {
    if (!Array.isArray(profile.service_kinds)) {
      throw new GatewayError("invalid_request", 400, "service_kinds must be an array. Check the shape of what you sent — then resend 🪞");
    }
    for (const kind of profile.service_kinds) {
      if (!isServiceKind(kind)) {
        throw new GatewayError("invalid_request", 400, `unknown service kind ${String(kind)}. Check the shape of what you sent — then resend 🪞`);
      }
    }
  }
  if (profile.cli_identity !== undefined) {
    if (typeof profile.cli_identity !== "boolean") {
      throw new GatewayError("invalid_request", 400, "cli_identity must be boolean. Check the shape of what you sent — then resend 🪞");
    }
  }
  if (profile.gateway_user_agent !== undefined) {
    if (typeof profile.gateway_user_agent !== "boolean") {
      throw new GatewayError("invalid_request", 400, "gateway_user_agent must be boolean. Check the shape of what you sent — then resend 🪞");
    }
  }
  if (profile.extra_headers) {
    for (const [rawName, rawValue] of Object.entries(profile.extra_headers)) {
      const name = rawName.toLowerCase();
      if (name.length < 1 || name.length > 64 || !TOKEN_REGEX.test(name)) {
        throw new GatewayError("invalid_request", 400, `invalid header name ${rawName}. Check the shape of what you sent — then resend 🪞`);
      }
      if (isProtectedHeader(name, ADAPTER_OWNED)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `header ${rawName} is not allowed as custom header. Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (typeof rawValue !== "string") {
        throw new GatewayError(
          "invalid_request",
          400,
          `header value for ${rawName} must be string. Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (Buffer.byteLength(rawValue, "utf8") > 4096) {
        throw new GatewayError("invalid_request", 400, `header value for ${rawName} exceeds 4KiB. We love long reads, but not that long 📚`);
      }
      if (/[\r\n\x00-\x1f\x7f]/.test(rawValue)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `header value for ${rawName} contains control characters. Check the shape of what you sent — then resend 🪞`,
        );
      }
    }
  }
  if (profile.extra_query_params) {
    for (const [k, v] of Object.entries(profile.extra_query_params)) {
      if (typeof v !== "string")
        throw new GatewayError("invalid_request", 400, `query param ${k} must be string. Check the shape of what you sent — then resend 🪞`);
      if (/[\r\n]/.test(k) || /[\r\n]/.test(v))
        throw new GatewayError("invalid_request", 400, `query param contains CRLF. Check the shape of what you sent — then resend 🪞`);
    }
  }
  if (profile.endpoint_paths_by_wire_family) {
    for (const [wf, path] of Object.entries(profile.endpoint_paths_by_wire_family)) {
      if (!isWireFamily(wf)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family: unknown wire family ${wf}. Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (typeof path !== "string") {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} must be string. Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (path.length === 0 || path.length > 256) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} path length must be 1-256 chars. Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (!path.startsWith("/")) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} path must start with /. Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (/[\s\r\n\x00-\x1f\x7f]/.test(path)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} path contains invalid characters. Check the shape of what you sent — then resend 🪞`,
        );
      }
    }
  }
  if (profile.model_wire_families) {
    if (!Array.isArray(profile.model_wire_families)) {
      throw new GatewayError("invalid_request", 400, "model_wire_families must be an array. Check the shape of what you sent — then resend 🪞");
    }
    for (const rule of profile.model_wire_families) {
      if (typeof rule?.pattern !== "string" || rule.pattern.length === 0) {
        throw new GatewayError(
          "invalid_request",
          400,
          "model_wire_families[].pattern must be a non-empty string. Check the shape of what you sent — then resend 🪞",
        );
      }
      if (rule.pattern.length > 256) {
        throw new GatewayError(
          "invalid_request",
          400,
          "model_wire_families[].pattern must be at most 256 chars. Check the shape of what you sent — then resend 🪞",
        );
      }
      try {
        new RegExp(rule.pattern);
      } catch {
        throw new GatewayError(
          "invalid_request",
          400,
          `model_wire_families[].pattern ${rule.pattern} is not a valid regular expression. Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (!isWireFamily(rule.wire_family)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `model_wire_families[].wire_family: unknown wire family ${String(rule.wire_family)}. Check the shape of what you sent — then resend 🪞`,
        );
      }
    }
  }
  if (
    profile.streaming_usage_mode &&
    !["include_usage", "none"].includes(profile.streaming_usage_mode)
  ) {
    throw new GatewayError("invalid_request", 400, "invalid streaming_usage_mode. Check the shape of what you sent — then resend 🪞");
  }
  if (profile.structured_output && typeof profile.structured_output.enabled !== "boolean") {
    throw new GatewayError("invalid_request", 400, "structured_output.enabled must be boolean. Check the shape of what you sent — then resend 🪞");
  }
  // If any field is present but has no runtime reader, our current reader set covers all fields above.
  const allowed: Record<string, true> = {
    extra_headers: true,
    extra_query_params: true,
    endpoint_paths_by_wire_family: true,
    // Validated above and read by `probe-phases.ts` during model discovery:
    // per-model wire-family routing for BYOK rows.
    model_wire_families: true,
    // Validated above and read by `compatible-adapter.ts` at dispatch.
    streaming_usage_mode: true,
    structured_output: true,
    // Read by `resolveCustomCliHeaders` in provider-catalog-service: a custom
    // provider's BYOK adapter stamps official CLI identity headers unless the
    // operator opts out. Omitting it here rejected every create/update that
    // carried the flag the dashboard always sends.
    cli_identity: true,
    // Explicit gateway-identity opt-in for BYOK rows (mirrors
    // `ApiKeyProviderSpec.gatewayUserAgent` for bundled specs).
    gateway_user_agent: true,
  };
  for (const k of Object.keys(profile)) {
    if (!allowed[k]) {
      throw new GatewayError(
        "invalid_request",
        400,
        `unknown compatibility_profile field ${k} has no runtime reader. Check the shape of what you sent — then resend 🪞`,
      );
    }
  }
}
