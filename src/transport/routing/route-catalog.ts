// Routing snapshot: builds the RouteSnapshot from the persisted model catalog.
//
// Facade over the split modules:
// - `route-catalog-helpers.ts` — pure capability/profile/user-agent helpers and
//   the snapshot's column projections.
// - `route-catalog-read.ts` — the thirteen-row-set catalog read
//   (`readCatalogRows`, `CatalogRead`).
// - `route-catalog-repository.ts` — the repository assembly
//   (`RouteCatalogRepository`, `RouteCatalogBuildContext`,
//   `createDatabaseSnapshotBuilder`).
//
// The public surface is unchanged from the pre-split module.

export { buildCapabilityProfile } from "./route-catalog-helpers";
export { capabilityProfileCacheSize } from "./route-catalog-helpers";
export { cliMappingSourceKeys } from "./route-catalog-helpers";
export { resolveRouteUserAgent } from "./route-catalog-helpers";
export { createDatabaseSnapshotBuilder } from "./route-catalog-repository";
