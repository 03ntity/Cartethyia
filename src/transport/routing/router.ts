// Routing model resolution and route planning.
// Facade module: the public routing surface. The implementation lives in
// sibling modules — alias/combo target resolution in `alias-resolution.ts`,
// the `RoutingEngine` planning/admission core in `routing-engine.ts` — so
// importers of this module keep working unchanged.
export { RoutingEngine } from "./routing-engine";
export { resolveAliasTarget } from "./alias-resolution";

// Public API preserved across the candidate-evaluation / provider-routing
// split: importers of router.ts keep working unchanged.
export {
  EligibilityEvaluator,
  QUOTA_FRESHNESS_HORIZON_MS,
  accountRemainingCredit,
  allWindowsExhausted,
  creditPriority,
  earliestResetMs,
  exhaustedResetMs,
  filterCandidateQuotaWindows,
  hotWindow,
  normalizeQuotaFact,
  spreadDeadline,
  usageFloorStateFor,
} from "./candidate-evaluation";
