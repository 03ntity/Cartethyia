/**
 * Usage-period presets, in the backend's canonical module so the console API
 * and the dashboard can never drift apart. The module is valueless by design
 * (no Elysia, no node APIs), so importing it from the browser is safe.
 */
export { USAGE_PERIODS } from "../../../src/console/observability/usage-periods";
export type { UsagePeriod } from "../../../src/console/observability/usage-periods";
