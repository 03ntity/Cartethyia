// Pure network identity matching: CIDR/IP helpers and trusted-proxy client identity.

import { isIP } from "node:net";
import type { TrustedProxyBoundary } from "../config/network";
import { log } from "../observability/logger";

function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return undefined;
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

function ipv6ToBigInt(address: string): bigint | undefined {
  const value = address.toLowerCase().split("%", 1)[0] ?? "";
  if (value.includes(".")) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part)))
    return undefined;
  let result = 0n;
  for (const group of groups) result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  return result;
}

/**
 * Unwraps an IPv4-mapped IPv6 address to plain IPv4.
 *
 * Bun reports an IPv4 loopback peer as `::ffff:127.0.0.1` on Windows, and
 * `isIP` classifies it as IPv6 — so `ipv6ToBigInt` (which bails on a dotted
 * quad) never matched `127.0.0.1/32`. The trust check therefore failed for the
 * exact peer `TRUSTED_PROXY_CIDRS=127.0.0.1/32` is meant to cover, forwarded
 * headers were ignored, and every cloudflared request stored the loopback peer
 * as the client address. Accepts both the dotted and the hex (`::ffff:7f00:1`)
 * spelling.
 */
function unwrapMappedIpv4(address: string): string {
  const value = address.toLowerCase().split("%", 1)[0] ?? "";
  // Recognize the mapped range STRUCTURALLY, not by its compressed spelling. The
  // old `startsWith("::ffff:")` test missed any form that writes the leading zero
  // groups out — `0:0:0:0:0:ffff:7f00:1` is the same host as `::ffff:127.0.0.1`,
  // but it failed the prefix test, fell through to `ipv6ToBigInt`, and was treated
  // as an unrelated IPv6 address. The trust check then refused a peer the allowlist
  // covered, and `canonicalClientIpKey` minted a second key for one host — which is
  // stored on issued child keys for consistent usage reporting and audit.
  //
  // A mapped address is `::ffff:<32 bits>`, i.e. the first 80 bits are zero and the
  // next 16 are `0xffff`. Matching that is the same test `isIP` uses internally.
  const tail = mappedIpv4Tail(value);
  if (tail === undefined) return address;
  // `mappedIpv4Tail` always returns two hex groups, so the dotted and hex
  // spellings have already converged by here.
  const groups = tail.split(":");
  if (groups.length !== 2) return address;
  const high = Number.parseInt(groups[0] ?? "", 16);
  const low = Number.parseInt(groups[1] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff)
    return address;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/**
 * The 32-bit tail of an IPv4-mapped IPv6 address, or `undefined` when `value` is
 * not one. Accepts every spelling of the same address: `::ffff:1.2.3.4`,
 * `::ffff:102:304`, `0:0:0:0:0:ffff:102:304`, and `::ffff:0:102:304`.
 *
 * Works by normalizing to exactly eight 16-bit groups first. That is the only way
 * to compare spellings: a dotted tail is written as ONE colon-separated token but
 * occupies TWO group slots, so any check that counts `split(":")` entries gets the
 * position of the `ffff` marker wrong.
 */
function mappedIpv4Tail(value: string): string | undefined {
  const groups = normalizeIpv6Groups(value);
  if (groups === undefined) return undefined;
  // The first five groups (80 bits) must be zero, and the sixth must be `ffff`.
  for (let index = 0; index < 5; index += 1) {
    if (groups[index] !== "0") return undefined;
  }
  if (groups[5] !== "ffff") return undefined;
  const high = groups[6];
  const low = groups[7];
  if (high === undefined || low === undefined) return undefined;
  return `${high}:${low}`;
}

/**
 * An IPv6 literal as exactly eight lowercase 16-bit hex groups, or `undefined`
 * when it is not one. Expands a `::` run and converts a trailing dotted quad into
 * the two groups it represents.
 */
function normalizeIpv6Groups(value: string): string[] | undefined {
  const text = value.trim();
  if (text.length === 0) return undefined;
  const doubleIndex = text.indexOf("::");
  // More than one `::` is invalid, as is a `::` inside a group.
  if (doubleIndex !== text.lastIndexOf("::")) return undefined;

  const headText = doubleIndex >= 0 ? text.slice(0, doubleIndex) : text;
  const tailText = doubleIndex >= 0 ? text.slice(doubleIndex + 2) : "";
  const head = headText.length > 0 ? headText.split(":") : [];
  const tail = tailText.length > 0 ? tailText.split(":") : [];

  // A dotted quad is a single token that fills two groups.
  const expandDotted = (tokens: string[]): string[] | undefined => {
    const last = tokens[tokens.length - 1];
    if (last === undefined || !last.includes(".")) return tokens;
    const quad = last.split(".");
    if (quad.length !== 4) return undefined;
    const octets = quad.map((part) => Number(part));
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    const [a, b, c, d] = octets;
    if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    return [...tokens.slice(0, -1), high, low];
  };

  const expandedHead = expandDotted(head);
  const expandedTail = expandDotted(tail);
  if (expandedHead === undefined || expandedTail === undefined) return undefined;

  let full: string[];
  if (doubleIndex >= 0) {
    const missing = 8 - expandedHead.length - expandedTail.length;
    // `::` must stand for at least one group, so exactly-8 without it is invalid.
    if (missing < 1) return undefined;
    full = [...expandedHead, ...Array.from({ length: missing }, () => "0"), ...expandedTail];
  } else {
    full = expandedHead;
  }
  if (full.length !== 8) return undefined;
  const normalized: string[] = [];
  for (const group of full) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    normalized.push(Number.parseInt(group, 16).toString(16));
  }
  return normalized;
}

function matchesCidr(address: string, cidr: string): boolean {
  const [network, rawPrefix] = cidr.split("/");
  if (!network) return false;
  // A bare address (`"127.0.0.1"`) has no prefix and means "this exact host". A
  // present-but-blank prefix (`"10.0.0.0/"`) must NOT be treated as /0: `Number("")`
  // is 0, and /0 matches every address — which made `isTrustedProxyPeer` true for
  // ANY peer, so the gateway believed a caller's own `X-Forwarded-For` and every
  // per-address decision downstream (abuse throttling, model bans, the audit
  // trail) read a forged value.
  //
  // Requiring a run of digits also refuses the exotic spellings `Number` accepts
  // for zero (`-0`, `+0`, `0x0`, `0b0`, `0o0`, `0.0`), all of which are typos
  // rather than a deliberate "trust everyone".
  const prefixText = rawPrefix === undefined ? undefined : rawPrefix.trim();
  if (prefixText !== undefined && !/^\d+$/.test(prefixText)) return false;
  // A mapped peer and a plain-IPv4 allowlist entry describe the same host.
  const subject = unwrapMappedIpv4(address);
  const base = unwrapMappedIpv4(network);
  const family = isIP(subject);
  if (family === 4) {
    const value = ipv4ToNumber(subject);
    const networkValue = ipv4ToNumber(base);
    if (value === undefined || networkValue === undefined) return false;
    const prefix = prefixText === undefined ? 32 : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((value >>> 0) & mask) === ((networkValue >>> 0) & mask);
  }
  if (family !== 6) return false;
  const value = ipv6ToBigInt(subject);
  const networkValue = ipv6ToBigInt(base);
  if (value === undefined || networkValue === undefined) return false;
  const prefix = prefixText === undefined ? 128 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (networkValue >> shift);
}

function isTrustedPeer(peer: string, boundary: TrustedProxyBoundary): boolean {
  // `platform` mode has no allowlist to match: the PaaS edge is the only way
  // in, which is what the mode asserts. See `TrustedProxyMode`.
  if (boundary.mode === "platform") return true;
  return boundary.allowlist?.some((entry) => matchesCidr(peer, entry)) ?? false;
}

/** Whether the TCP peer may vouch for forwarded headers (reverse-proxy trust). */
export function isTrustedProxyPeer(peer: string, boundary: TrustedProxyBoundary): boolean {
  return boundary.mode !== "disabled" && isTrustedPeer(peer, boundary);
}

/** Forwarded client-address headers, in the order they are believed. */
const CLIENT_IDENTITY_HEADERS = [
  "cf-connecting-ip",
  "true-client-ip",
  "x-forwarded-for",
  "x-real-ip",
] as const;

/**
 * True when `address` is a loopback address.
 *
 * Structural, not a string-prefix test: `127.0.0.1`, `::1`, and the mapped
 * `::ffff:127.0.0.1` a Windows/Bun peer arrives as are all the same host, and
 * a prefix test would miss the mapped form — the exact shape that hid this
 * class of bug before.
 */
export function isLoopbackAddress(address: string): boolean {
  const normalized = unwrapMappedIpv4(address.trim().split("%", 1)[0] ?? "");
  if (normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  const value = ipv4ToNumber(normalized);
  // 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1.
  return value !== undefined && ((value >>> 0) & 0xff000000) === (127 << 24);
}

/**
 * Whether a peer may vouch for forwarded headers *for client-address
 * resolution*.
 *
 * Wider than {@link isTrustedProxyPeer} by exactly one arm: an unconfigured
 * deployment (`mode: "disabled"`, no `TRUSTED_PROXY_CIDRS`) still trusts a
 * **loopback** peer. That arm is the fix for the tunnel collapse. A tunnel
 * (cloudflared, an SSH forward, a local Caddy/Nginx) is the ordinary reason a
 * request carries forwarded headers while its TCP peer is `127.0.0.1`, and
 * with nothing configured the old behavior ignored them — so every caller
 * behind the tunnel was recorded as the loopback address. Per-address abuse
 * throttling and model bans, both keyed on this value, then applied to all of
 * them together: one caller reaching the limit banned every other caller
 * behind the same tunnel.
 *
 * Deliberately NOT widened in {@link isTrustedProxyPeer} itself, because that
 * predicate also gates the console cookie's `secure` upgrade
 * (`securePolicyForRequest`) and the address source label in `request-context`.
 * Widening it there would change two decisions this change was not asked to
 * make. The one place the collapse is harmful is the client address, so that
 * is the one place the arm applies — and the difference is documented rather
 * than left as two predicates that silently disagree.
 *
 * An explicit `TRUSTED_PROXY_CIDRS` always overrides this: a configured
 * boundary is `trusted` or `platform`, and neither mode reaches the loopback
 * arm. An operator who names an allowlist that omits loopback has said the
 * tunnel is not trusted, and gets the warning instead.
 */
function isTrustedForClientAddress(peer: string, boundary: TrustedProxyBoundary): boolean {
  if (isTrustedProxyPeer(peer, boundary)) return true;
  // Only an *unconfigured* boundary takes the loopback arm — `disabled` with no
  // allowlist, which is exactly the shape `resolveTrustedProxyBoundary()` returns
  // when `TRUSTED_PROXY_CIDRS` is unset. A boundary that carries an allowlist is
  // a configured one whatever its mode says, and honoring the arm there would
  // contradict the operator's explicit `disabled`: `{ mode: "disabled",
  // allowlist: [...] }` must keep ignoring forwarded headers, which is what the
  // regression test for that shape pins.
  return (
    boundary.mode === "disabled" &&
    boundary.allowlist === undefined &&
    isLoopbackAddress(peer)
  );
}

/**
 * Whether this request looks like it arrived through a reverse proxy whose
 * forwarded headers the current boundary is going to ignore.
 *
 * The signature is a forwarded client-address header arriving from a peer whose
 * headers will not be believed. On its own that is normal and safe — any client
 * can send `X-Forwarded-For`, and ignoring it is correct. What makes it
 * dangerous is the peer being **loopback**: that is the shape of a tunnel, and
 * when the tunnel's headers are ignored every caller behind it collapses onto
 * one address.
 *
 * That collapse is not cosmetic. Per-address abuse throttling
 * (`IpAbuseProtectionService`) and model-abuse bans are keyed on this value, so
 * one caller reaching the limit bans every other caller behind the same
 * tunnel — the shared-fate failure that motivated this check. It is also
 * fail-open in the audit trail: the operator sees `127.0.0.1` for everyone.
 */
export function isSuspectedProxyCollapse(
  request: Request,
  boundary: TrustedProxyBoundary,
  peer: string,
): boolean {
  // Same predicate the resolver uses, so this cannot report a collapse that
  // the resolver has actually avoided.
  if (isTrustedForClientAddress(peer, boundary)) return false;
  if (!isLoopbackAddress(peer)) return false;
  return CLIENT_IDENTITY_HEADERS.some((name) => {
    const value = request.headers.get(name);
    return value !== null && value.trim().length > 0;
  });
}

/**
 * Warns once when a deployment is silently collapsing every caller onto one
 * address.
 *
 * Once, not per request: this path is on every `/v1/*` request, and a busy
 * gateway would otherwise emit the same paragraph thousands of times a minute.
 * The first occurrence is the one that names the fix; after that the condition
 * is unchanged and repeating it is noise.
 */
let collapseWarned = false;
/** Test seam: lets a suite assert the warning fires without process state. */
export function resetProxyCollapseWarningForTests(): void {
  collapseWarned = false;
}

function maybeWarnIgnoredForwardedHeaders(
  request: Request,
  boundary: TrustedProxyBoundary,
  peer: string,
): void {
  if (collapseWarned) return;
  if (!isSuspectedProxyCollapse(request, boundary, peer)) return;
  collapseWarned = true;
  // Via `log`, so this ships through the same transport as everything else and
  // is level-filtered. It was `console.warn` to keep the module importable
  // without the logger, but the logger pulls in only pino, the console log ring
  // and its own sanitizer — none of which import this module — so there is no
  // cycle and the boundary tests import it the same way production does.
  log.warn(
    `[ip-boundary] A forwarded client-address header arrived from a loopback peer ` +
      `(${unwrapMappedIpv4(peer)}) but the trusted-proxy boundary does not trust it, so ` +
      `the client address is the loopback peer for every caller. Every caller behind this ` +
      `tunnel then shares one address: per-IP abuse limits and model bans apply to all ` +
      `of them together, and the audit trail shows one address for everyone. ` +
      `Set TRUSTED_PROXY_CIDRS=127.0.0.1/32 (add ::1/128 for IPv6) to trust it explicitly.`,
  );
}

/**
 * trusts the raw TCP peer. `"trusted"` trusts proxy identity headers only when
 * the TCP peer itself matches `allowlist` (CIDR or exact address). `"platform"`
 * trusts them from any peer, for a PaaS edge that cannot be allowlisted.
 *
 * `CF-Connecting-IP` and `True-Client-IP` are preferred: both are single-valued
 * and overwritten by the edge, so they cannot carry a caller-supplied value.
 * The forwarded chain is read from its left end, which assumes the edge
 * *prepends* the address it observed — cloudflared's behavior, and the reason
 * the loopback allowlist works. An edge that instead *appends* leaves whatever
 * the caller sent at the left end, where it would be selected; a deployment
 * behind such an edge should send `CF-Connecting-IP`/`True-Client-IP` (both
 * overwritten) or a trusted-peer allowlist narrow enough that direct callers
 * cannot reach it. Which one Railway does is not established here.
 */
export function resolveClientIdentity(
  request: Request,
  boundary: TrustedProxyBoundary,
  peer: string,
): string {
  const fallback = unwrapMappedIpv4(peer);
  // `isTrustedForClientAddress`, not `isTrustedProxyPeer`: an unconfigured
  // deployment trusts a loopback peer here, so a tunnel's forwarded headers are
  // believed and its callers keep their own addresses. See that function for
  // why the arm is here and not in `isTrustedProxyPeer`.
  if (!isTrustedForClientAddress(peer, boundary)) {
    maybeWarnIgnoredForwardedHeaders(request, boundary, peer);
    return fallback;
  }
  // The trust gate is above. The check that used to stand here gated on
  // `isTrustedPeer`, which never consults `mode` unless it is `platform` — so a
  // boundary carrying both `disabled` and an allowlist honored forwarded headers
  // while `isTrustedProxyPeer` refused the same peer, and the module held two
  // contradictory answers to "is this peer trusted?" for one request. The
  // consequence was the spoofing property: a caller able to reach the port named
  // its own client address — the dimension the per-IP abuse limits are counted
  // on. `isTrustedForClientAddress` (above) is the single gate now: it defers to
  // `isTrustedProxyPeer`, so the `disabled` mode it names is honored, and it adds
  // only the loopback arm this function documents.
  for (const name of CLIENT_IDENTITY_HEADERS) {
    const values = (request.headers.get(name) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    // A proxy may itself forward a mapped form; store the canonical spelling
    // so one host is one dimension value rather than two.
    if (values[0]) return unwrapMappedIpv4(values[0]);
  }
  return fallback;
}

/**
 * Produces a stable, family-tagged identity key for database uniqueness.
 * Mapped IPv4 and alternate IPv6 spellings collapse to one canonical address.
 */
export function canonicalClientIpKey(address: string): string | undefined {
  const normalized = unwrapMappedIpv4(address);
  const family = isIP(normalized);
  if (family === 4) {
    const value = ipv4ToNumber(normalized);
    return value === undefined ? undefined : `v4:${value}`;
  }
  if (family === 6) {
    const value = ipv6ToBigInt(normalized);
    return value === undefined ? undefined : `v6:${value.toString(16).padStart(32, "0")}`;
  }
  return undefined;
}
