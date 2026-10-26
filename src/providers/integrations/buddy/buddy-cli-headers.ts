/**
 * The header family only the CLI identity sends.
 *
 * Everything here comes from the two reference gateways, which agree: the
 * desktop product sends conversation/tracing headers and a device token, while
 * the CLI sends the agent envelope plus the OpenAI Node SDK fingerprint. The
 * CLI still drops the browser *transport* headers (`origin`, `referer`,
 * `accept-language`) and the device token, but keeps the request-shape markers
 * (`x-requested-with`, `x-codebuddy-request`) the reference sends on every call
 * regardless of transport — see the CLI branches in each provider's
 * `*-shared.ts`.
 *
 * The SDK fingerprint is pinned, not host-derived. Both references pin a fixed
 * set (codebuddy2api pins Linux/x64/v24.21.0); this gateway pins the macOS set
 * instead, so every CLI dispatch presents one consistent client fingerprint no
 * matter which machine the gateway runs on. A host-derived fingerprint would
 * advertise whatever OS the process happens to run under — a value no upstream
 * risk model has seen for this client brand, and an easy outlier to key on.
 */

/** OpenAI Node SDK 6.25.0 `x-stainless-*` fingerprint; both references agree. */
const STAINLESS_PACKAGE_VERSION = "6.25.0";

/**
 * The pinned Node runtime the fingerprint claims. Held constant across
 * dispatches: a drifting `process.version` would advertise a different Node
 * build per deployment, which is not what one installed client looks like.
 */
const STAINLESS_RUNTIME_VERSION = "v24.21.0";

/**
 * The SDK fingerprint headers.
 *
 * `x-stainless-timeout` is in the hub only and `x-stainless-retry-count` is in
 * both; the SDK sends both, so both go out. The OS/arch pair is the pinned
 * macOS fingerprint rather than this process's host.
 */
export function buddyStainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-lang": "js",
    "x-stainless-package-version": STAINLESS_PACKAGE_VERSION,
    "x-stainless-os": "MacOS",
    "x-stainless-arch": "x64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": STAINLESS_RUNTIME_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "1200",
  };
}

/**
 * The trace family the CLI carries as a child span.
 *
 * The desktop product omits the parent (`with_parent=False` in the reference);
 * the CLI conversation request is a child span, so it also sends `b3`'s fourth
 * field and `X-B3-ParentSpanId`. `buddyConversationHeaders` already produces
 * `traceparent`, `b3`, and the `X-B3-*` set, so only the parent is added here.
 */
export function buddyCliTraceHeaders(
  conversation: Readonly<Record<string, string>>,
): Record<string, string> {
  const traceId = conversation["x-trace-id"] ?? conversation["x-b3-traceid"];
  const spanId = conversation["x-b3-spanid"];
  if (traceId === undefined) return {};
  const b3 = `${traceId}-${spanId ?? traceId.slice(0, 16)}-1-${traceId.slice(0, 16)}`;
  return { ...(spanId === undefined ? {} : { "X-B3-ParentSpanId": spanId }), b3 };
}

/**
 * The full CLI identity envelope, minus what each caller already supplies.
 *
 * The caller keeps ownership of `User-Agent`, `X-IDE-*`, `X-Domain`, and the
 * conversation family, because those vary by provider and realm: only the
 * headers that are the same for every CLI dispatch are built here.
 */
export function buddyCliHeaders(args: {
  readonly userId: string;
  readonly enterpriseId?: string | undefined;
}): Record<string, string> {
  const enterpriseId =
    args.enterpriseId !== undefined && args.enterpriseId.trim().length > 0
      ? args.enterpriseId.trim()
      : undefined;
  return {
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    // The reference enum is local-agent / cloud-agent / agent-agent, and its
    // parser returns "other" for anything unknown or absent. A gateway is none
    // of the three, so "other" is the honest value rather than a guess.
    "X-Agent-Runtime": "other",
    "X-User-Id": args.userId,
    // The reference sends the flag either way, `true` only for an enterprise
    // id. A personal account stays `false`; an enterprise account flips to
    // `true` and names the enterprise, because the two travel together — a
    // `true` with no id, or an id under `false`, is a combination no real
    // client produces.
    "X-Private-Data": enterpriseId === undefined ? "false" : "true",
    ...(enterpriseId === undefined
      ? {}
      : {
          "X-Enterprise-Id": enterpriseId,
          // The tenant falls back to the enterprise: the two are the same value
          // for an account that belongs to one enterprise, and the upstream
          // reads both.
          "X-Tenant-Id": enterpriseId,
        }),
    ...buddyStainlessHeaders(),
  };
}
