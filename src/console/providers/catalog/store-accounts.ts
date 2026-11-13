/**
 * Provider-account persistence for the catalog store, split on clean seams:
 *
 * - `store-account-queries.ts` — account reads: list queries, id/ownership
 *   probes, per-provider counts, and usage aggregation.
 * - `store-account-mutations.ts` — credential writes: label generation,
 *   single and batch create, update, and reorder.
 * - `store-pool-accounts.ts` — pool-as-account reads and projection.
 *
 * This file re-exports the full public surface so importers keep resolving
 * through the module path they already use. Every function takes the shared
 * `StoreAccountContext` the owning `DrizzleProviderCatalogStore` builds.
 */
export {
  accountsWithUsage,
  getOwnedAccount,
  listAccountAuthStates,
  listAccountIds,
  listAccounts,
  listAllAccountSummaries,
  listAllAccounts,
  ownsAccount,
  providerAccountCounts,
  providerModelCounts,
} from "./store-account-queries";
export {
  createAccountBatch,
  createAccountRow,
  reorderAccounts,
  updateAccountRow,
} from "./store-account-mutations";
export {
  listAllPoolAccounts,
  listPoolAccounts,
} from "./store-pool-accounts";
export { mapAccountRow } from "./store-helpers";
