/**
 * Client identity straight from the stored `User-Agent`: the first RFC 9110
 * product token carries both the client and its version (`bun/1.2.3`,
 * `codex-cli/0.1.0`), so no prefix catalog can drift from what the client
 * actually sent. Browser agents start with the historical `Mozilla/5.0`
 * token, which names no real client, so they report as `Browser`.
 *
 * Canonical location: this is stamped at ingestion (`telemetryEventRow`) so
 * `telemetry_events.client_name` groups client breakdowns in SQL, and reused
 * by the console read side and the backfill for the same grouping.
 */
export function clientNameFromUserAgent(userAgent: string | null | undefined): string {
  const raw = userAgent?.trim();
  if (!raw) return "unknown";
  if (/^mozilla\//i.test(raw)) return "Browser";
  const product = raw.split(/\s+/, 1)[0] ?? "";
  const slash = product.indexOf("/");
  const token = slash <= 0
    ? product
    : product.slice(0, slash + 1).concat(product.slice(slash + 1).split(/[;,)]/, 1)[0] ?? "");
  return token || "unknown";
}
