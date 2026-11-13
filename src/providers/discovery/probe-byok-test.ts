/**
 * Ad-hoc BYOK connection test.
 *
 * Dispatches a real `GET <base>/models` through the same SSRF-validated
 * outbound fetch live traffic uses, stamping the credential with the auth
 * header the chosen wire family actually reads (`x-api-key` for Messages,
 * `Authorization: Bearer` otherwise) plus that wire's CLI identity headers.
 * Reachability is the contract: any HTTP response proves the operator's base
 * URL, credential, and egress path work — a 4xx is reported with its status
 * rather than disguised as a transport failure.
 */
import { WIRE_FAMILIES } from "../../protocol/canonical-model";
import type { WireFamily } from "../../protocol/canonical-model";
import { isRecord } from "../../protocol/codecs";
import type {
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
} from "./discovery-types";
import { createProbeFetch } from "../provider-probe";
import { authHeaders } from "../adapters/compatible-adapter";
import {
  byokAuthHeaderShape,
  modelListUrl,
  splitEndpointBaseUrl,
} from "../operations/byok-wire-profile";
import { resolveCustomCliHeaders } from "../operations/custom-cli-headers";
import type { ProbeOutboundResolver } from "./probe-outbound";
import { asOutboundBinding } from "./probe-outbound";
export async function testByokConnection(
  outboundFetchFor: ProbeOutboundResolver,
  tenantId: string,
  request: ByokConnectionTestRequest,
): Promise<ByokConnectionTestResult> {
  const startedAt = Date.now();
  const requestedWire = request.wireFamily;
  const wireFamily: WireFamily = (WIRE_FAMILIES as readonly string[]).includes(requestedWire)
    ? (requestedWire as WireFamily)
    : "chat";
  // An operator who pasted a full endpoint (`…/anthropic/v1/messages`) gets it
  // stripped before the model list is derived, and told so. Probing the
  // corrected root is what makes the result actionable: the alternative is a
  // bare 404 against a path the gateway built from their own typo.
  const submitted = splitEndpointBaseUrl(request.baseUrl);
  const warning =
    submitted.stripped === ""
      ? undefined
      : `Base URL pointed at the endpoint "${submitted.stripped}". Cartethyia derives the model list from the root, so it tested "${submitted.baseUrl}" instead. Save that root as the Base URL.`;
  const url = modelListUrl(request.baseUrl);
  const outbound = asOutboundBinding(await outboundFetchFor(tenantId));
  const probeFetch = createProbeFetch(outbound.fetch);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...authHeaders(
        byokAuthHeaderShape([wireFamily]),
        new TextEncoder().encode(request.apiKey),
        request.apiKey.trim().length > 0 ? "api_key" : "none",
      ),
      ...(request.cliIdentity === false ? {} : resolveCustomCliHeaders(wireFamily)),
      ...(request.extraHeaders ?? {}),
    };
    const response = await probeFetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        statusCode: response.status,
        error: `Upstream rejected the connection test with HTTP ${response.status}`,
        ...(warning === undefined ? {} : { warning }),
      };
    }
    // A body is nice to have but not required: some gateways answer `/models`
    // with an empty envelope. Read it defensively so a non-JSON body cannot
    // turn a successful reachability check into a failure.
    let modelCount: number | undefined;
    try {
      const payload = (await response.json()) as unknown;
      const entries = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload["data"])
          ? payload["data"]
          : isRecord(payload) && Array.isArray(payload["models"])
            ? payload["models"]
            : undefined;
      if (entries) modelCount = entries.length;
    } catch {
      // Non-JSON success body: reachability already proven by the 2xx.
    }
    return {
      ok: true,
      latencyMs,
      statusCode: response.status,
      ...(modelCount === undefined ? {} : { modelCount }),
      ...(warning === undefined ? {} : { warning }),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Connection test failed",
      ...(warning === undefined ? {} : { warning }),
    };
  } finally {
    outbound.release?.();
  }
}
