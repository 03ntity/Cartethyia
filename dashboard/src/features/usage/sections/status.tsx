import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../lib/classnames";
import { formatNumber } from "../../../lib/format/numbers";
import { httpStatusLabel, httpStatusShortLabel, httpStatusTone } from "../http-status";

export const STATUS_TONE_COLOR: Record<"ok" | "err" | "warn", string> = {
  ok: "var(--green)",
  err: "var(--red)",
  warn: "var(--orange)",
};

export function statusCode(
  status: string,
  httpStatus?: number,
): { code: string; tone: "ok" | "err" | "warn" } {
  if (httpStatus !== undefined) {
    const tone = httpStatus >= 500 || (httpStatus >= 400 && httpStatus !== 499)
      ? "err"
      : httpStatus === 200
        ? "ok"
        : "warn";
    return { code: httpStatusShortLabel(httpStatus), tone };
  }
  switch (status) {
    case "completed":
      return { code: httpStatusShortLabel(200), tone: "ok" };
    case "failed":
      return { code: httpStatusShortLabel(500), tone: "err" };
    case "cancelled":
      return { code: httpStatusShortLabel(499), tone: "warn" };
    case "truncated":
      return { code: httpStatusShortLabel(502), tone: "err" };
    default:
      return { code: status, tone: "warn" };
  }
}

/** The full-phrase code for the explainer: `500` -> `"500 Internal Server Error"`. */
function statusFullCode(status: string, httpStatus?: number): string {
  if (httpStatus !== undefined) return httpStatusLabel(httpStatus);
  switch (status) {
    case "completed":
      return httpStatusLabel(200);
    case "failed":
      return httpStatusLabel(500);
    case "cancelled":
      return httpStatusLabel(499);
    case "truncated":
      return httpStatusLabel(502);
    default:
      return status;
  }
}

/** One-line explainer for the actual client-facing HTTP status. */
function statusExplainer(
  status: string,
  errorKind: string | undefined,
  httpStatus?: number,
): string {
  if (httpStatus === 499 || status === "cancelled") {
    return `499 · client aborted the request (${errorKind ?? "cancelled"}) — not a gateway error`;
  }
  if (httpStatus === 200 || status === "completed") return "200 · request succeeded";
  const code = statusFullCode(status, httpStatus);
  return errorKind ? `${code} · ${errorKind}` : code;
}

/**
 * `200` confirms success, `499` names the client abort so a cancelled row is
 * never mistaken for a gateway error. Pure display — no error totals change.
 */
export function StatusCodeWithExplainer({
  status,
  errorKind,
  httpStatus,
}: {
  readonly status: string;
  readonly errorKind: string | undefined;
  readonly httpStatus?: number;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const code = statusCode(status, httpStatus);
  const explainer = statusExplainer(status, errorKind, httpStatus);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-expanded={open}
        aria-label={explainer}
        title={explainer}
        className={cn(
          "font-mono font-bold tabular-nums bg-transparent border border-transparent",
          "rounded-chip cursor-pointer px-2 py-0 text-[inherit]",
        )}
        style={{ color: STATUS_TONE_COLOR[code.tone] }}
      >
        {code.code}
      </button>
      {open ? (
        <span
          role="status"
          className="absolute top-full z-30 mt-1.5 left-0 whitespace-normal min-w-110 max-w-140 border border-inner-border rounded-control bg-popover-bg shadow-popout px-5 py-4 font-sans font-normal text-badge leading-snug text-text-secondary"
        >
          {explainer}
        </span>
      ) : null}
    </span>
  );
}

function errorMessageFor(errorKind: string | undefined): string {
  const messages: Record<string, string> = {
    transport_closed: "request was cancelled by client",
    transport_unavailable: "upstream stream failed or ended before completion",
    timeout: "request timed out before a response was received",
    deadline_exceeded: "upstream stream stalled past the deadline",
    invalid_request: "request was rejected as invalid",
    internal_error: "the gateway was misconfigured for this request",
    provider_error: "upstream provider returned an error",
    platform_unavailable: "upstream provider was unavailable",
    proxy_unreachable: "network proxy was unreachable",
    proxy_auth_required: "network proxy rejected the credential",
    // `quota_exceeded` is produced by four layers — an API key's rpm/daily/
    // monthly/lifetime budget, the per-IP abuse limit, the console mutation
    // limit, and upstream itself. Read `details.reason` before assuming which;
    // the plain-English text here is the shared thread, not the diagnosis.
    quota_exceeded: "a rate limit or budget was exhausted",
    authentication_failed: "upstream rejected the credential",
    capacity_exhausted: "the API key's concurrency limit was reached",
    provider_capacity_exhausted: "every account was at its max-inflight ceiling",
    upstream_queued: "the upstream queued this request; retry after the stated interval",
    model_not_found: "no route served this model",
    context_length_exceeded: "the request exceeded the model's context window",
    capability_unsupported: "the route does not support this request",
    admission_unavailable: "gateway dependencies were unavailable",
    unknown_error: "the upstream failure could not be classified",
    // Without an entry these fall through to a mechanical underscore-to-space
    // rendering of the raw code.
    accounts_unavailable: "no account for this route was available",
    accounts_rate_limited: "every account for this route is rate limited or cooling down",
    ambiguous_model: "the model id matched more than one route",
    invalid_pool_limits: "the network pool limits were rejected",
    max_connections_exceeded: "the connection ceiling was reached",
    proxy_pool_capacity_exceeded: "the proxy pool had no free slot",
    proxy_pool_cooldown: "the proxy pool is cooling down",
    proxy_pool_unavailable: "no usable proxy pool was available",
    proxy_pool_unhealthy: "the selected proxy pool could not establish a tunnel",
    slug_reserved: "that slug is reserved by the gateway",
    tenant_capacity_exhausted: "the tenant concurrency ceiling was reached",
    tls_rejected: "the upstream TLS handshake was rejected",
    tool_call_loop_detected: "the request looped on the same tool call",
    tunnel_setup_failed: "the tunnel could not be established",
    unsupported_field: "the request carried a field this route rejects",
    shutting_down: "the gateway was draining for a restart",
    restart_for_update: "the gateway was restarting for an update; retry shortly",
    upstream_not_found: "the upstream route did not exist",
    request_too_large: "the request body exceeded the size limit",
    proxy_pool_provider_capacity_exceeded:
      "this provider reached its ceiling on the selected proxy pool",
    proxy_pool_blocked: "the proxy pool refused this destination",
    policy_rejected: "gateway policy refused this request",
    link_not_found: "that share link does not exist",
    link_expired: "that share link has expired",
    link_revoked: "that share link was revoked",
    link_disabled: "that share link is disabled",
    invalid_sequence: "the request arrived out of sequence",
    invalid_lifecycle: "the request is not valid in its current state",
    unsupported_media_type: "the request's content type is not accepted",
    upstream_conflict: "upstream reported a conflict",
    upstream_unprocessable: "upstream could not process the request",
    overloaded: "the gateway was overloaded; retry shortly",
    client_router_denied: "the client router denied this request",
    model_abuse_banned: "this address is banned for this key after repeated invalid model requests",
  };
  if (errorKind && messages[errorKind]) return messages[errorKind];
  if (errorKind) return errorKind.replaceAll("_", " ");
  return "request failed";
}

/**
 * Names the failing layer before the message.
 *
 * `invalid_request` is recorded both when the caller's body is malformed (our
 * rejection) and when the upstream rejects a well-formed body (theirs). Without
 * the layer, an operator cannot tell whether to look at the router or at the
 * provider — which is the whole point of recording `error_origin`.
 */
function originLabel(errorOrigin: string | undefined): string {
  if (errorOrigin === "cartethyia") return "Gateway";
  if (errorOrigin === "upstream") return "Upstream";
  if (errorOrigin === "network") return "Network";
  return "";
}

/**
 * Drawer headline for a failed or cancelled request. A client abort is not an
 * error: the headline says so explicitly instead of blaming the gateway.
 */
export function errorLabel(
  status: string,
  errorKind: string | undefined,
  errorOrigin: string | undefined,
  httpStatus?: number,
): string {
  if (status === "cancelled") {
    const layer = originLabel(errorOrigin);
    const message = errorMessageFor(errorKind);
    return layer
      ? `Cancelled 499 · ${layer}: ${message} — not a gateway error`
      : `Cancelled 499: ${message} — not a gateway error`;
  }
  const code = statusCode(status, httpStatus).code.split(" ", 1)[0] ?? status;
  const layer = originLabel(errorOrigin);
  const message = errorMessageFor(errorKind);
  return layer ? `${message} · ${code} · ${layer}` : `${message} · ${code}`;
}

/** Statuses pinned as chips; everything else folds into the "More" menu. */
const PINNED_STATUS = 200;

function StatusFilterButton({
  status,
  count,
  pressed,
  onToggle,
}: {
  readonly status: number;
  readonly count: number;
  readonly pressed: boolean;
  readonly onToggle: (status: number) => void;
}): ReactNode {
  const label = httpStatusLabel(status);
  const tone = httpStatusTone(status);
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-2.5 min-h-10.5 px-3 py-0.5 border rounded-chip bg-surface-1 font-sans text-micro font-semibold leading-none whitespace-nowrap cursor-pointer ${pressed ? "border-current" : "border-inner-border text-text-secondary hover:border-current"} ${tone === "ok" ? "text-green" : tone === "warn" ? "text-orange" : "text-red"} ${pressed ? "" : "hover:bg-surface-muted"}`}
      data-tone={tone}
      aria-pressed={pressed}
      aria-label={`Filter ${label}: ${formatNumber(count)} requests`}
      title={`Show ${formatNumber(count)} requests with HTTP ${label}`}
      onClick={() => onToggle(status)}
    >
      <span>{label}</span>
      <span className="font-mono tabular-nums opacity-65" aria-hidden="true">· {formatNumber(count)}</span>
    </button>
  );
}

/**
 * HTTP status filters for the Requests table. `200 OK` stays a chip; the rest
 * live in a menu so a period full of errors does not flood the header.
 */
export function StatusFilters({
  counts,
  active,
  onToggle,
}: {
  readonly counts: readonly { readonly status: number; readonly count: number }[];
  readonly active: number | null;
  readonly onToggle: (status: number) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const present = counts.filter((entry) => entry.count > 0);
  const pinned = present.filter((entry) => entry.status === PINNED_STATUS);
  const rest = present.filter((entry) => entry.status !== PINNED_STATUS);
  const restTotal = rest.reduce((sum, entry) => sum + entry.count, 0);
  const restActive = rest.some((entry) => entry.status === active);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (present.length === 0) return null;
  return (
    <div className="inline-flex items-center flex-wrap gap-2" role="group" aria-label="Filter requests by HTTP status">
      {pinned.map((entry) => (
        <StatusFilterButton
          key={entry.status}
          status={entry.status}
          count={entry.count}
          pressed={active === entry.status}
          onToggle={onToggle}
        />
      ))}
      {rest.length > 0 ? (
        <div ref={rootRef} className="relative">
          <button
            type="button"
            className={`inline-flex items-center gap-2.5 min-h-10.5 px-3 py-0.5 border rounded-chip bg-surface-1 font-sans text-micro font-semibold leading-none whitespace-nowrap cursor-pointer ${restActive ? "border-current" : "border-inner-border text-text-secondary hover:border-current hover:bg-surface-muted"} ${restActive ? (httpStatusTone(active ?? 0) === "ok" ? "text-green" : httpStatusTone(active ?? 0) === "warn" ? "text-orange" : "text-red") : ""}`}
            data-tone={restActive ? httpStatusTone(active ?? 0) : undefined}
            aria-pressed={restActive}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={`More statuses: ${formatNumber(restTotal)} requests across ${rest.length}`}
            onClick={() => setOpen((value) => !value)}
          >
            <span>More</span>
            <span className="font-mono tabular-nums opacity-65" aria-hidden="true">· {formatNumber(restTotal)}</span>
            <ChevronDown size={10} aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
          </button>
          {open ? (
            <div
              role="menu"
              aria-label="Other HTTP statuses"
              className="absolute top-full z-50 mt-1 right-0 min-w-90 flex flex-col gap-1 border border-inner-border rounded-control bg-popover-bg shadow-popout p-2"
            >
              {rest.map((entry) => (
                <div key={entry.status} role="none" className="[&>button]:w-full [&>button]:justify-between">
                  <StatusFilterButton
                    status={entry.status}
                    count={entry.count}
                    pressed={active === entry.status}
                    onToggle={(status) => {
                      onToggle(status);
                      setOpen(false);
                    }}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
