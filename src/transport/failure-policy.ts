/**
 * Upstream failure policy — public surface.
 *
 * The implementation lives in two sibling modules so each owns one concern:
 *
 * - `upstream-errors.ts` — error-body/header extraction, provider error-code
 *   and identifier vocabulary, `classifyUpstreamError`, `statusToGatewayErrorCode`,
 *   and `mapUpstreamHttpError` / `throwIfHtmlResponse`.
 * - `failure-classify.ts` — `classifyUpstreamFailure`, the terminal-outcome
 *   classifiers, and the shared retry mechanics (`MIN_RETRY_BUDGET_MS`,
 *   `fallbackRetryDelayMs`, `sleep`).
 *
 * This file re-exports both so every existing `../failure-policy` /
 * `../../transport/failure-policy` importer is unchanged.
 */
export * from "./upstream-errors";
export * from "./failure-classify";
