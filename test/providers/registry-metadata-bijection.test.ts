/**
 * Every provider in the registry has a metadata row, and vice versa.
 *
 * `PROVIDER_CAPABILITIES` carries the loaders; `BUNDLED_PROVIDER_METADATA`
 * carries the identity (`displayName`, `baseUrl`, `wireFamilyDefault`,
 * `requiresAccount`, operator-facing fields). The two are joined by the
 * provider id, and nothing in the type system makes them agree: a new
 * registry entry can forget its metadata row (dashboard renders a provider
 * with no display name and the request router has no `baseUrl` to pin SSRF
 * against), and a metadata row with no registry entry advertises a provider
 * no account can be opened for.
 *
 * The parity test in `registry-integration-parity.test.ts` proves the loaders
 * work. This one proves the identity is filed. Together they are the whole
 * review surface for adding a provider.
 *
 * Today both sides are fully bijective and no allowlist is needed. The
 * `REGISTRY_WITHOUT_METADATA` / `METADATA_WITHOUT_REGISTRY` records are kept
 * so a future split-identity provider (one id in the registry mapping to a
 * shared metadata family, say) can be declared explicitly rather than by
 * loosening the test.
 */
import { expect, test } from "bun:test";
import { BUNDLED_PROVIDER_METADATA } from "../../src/providers/provider-metadata";
import { PROVIDER_CAPABILITIES } from "../../src/providers/default-registry";

/** Registry ids that deliberately do not have their own metadata row. */
const REGISTRY_WITHOUT_METADATA: Readonly<Record<string, string>> = {};

/** Metadata ids that deliberately do not have their own registry entry. */
const METADATA_WITHOUT_REGISTRY: Readonly<Record<string, string>> = {};

test("every registry provider has a metadata row (modulo allowlist)", () => {
  const metadataIds = new Set<string>();
  for (const row of BUNDLED_PROVIDER_METADATA) metadataIds.add(row.id);
  const missing: string[] = [];
  for (const providerId of Object.keys(PROVIDER_CAPABILITIES)) {
    if (metadataIds.has(providerId)) continue;
    if (REGISTRY_WITHOUT_METADATA[providerId] !== undefined) continue;
    missing.push(providerId);
  }
  expect(missing).toEqual([]);
});

test("every metadata row has a registry provider (modulo allowlist)", () => {
  const registryIds = new Set(Object.keys(PROVIDER_CAPABILITIES));
  const orphans: string[] = [];
  for (const row of BUNDLED_PROVIDER_METADATA) {
    if (registryIds.has(row.id)) continue;
    if (METADATA_WITHOUT_REGISTRY[row.id] !== undefined) continue;
    orphans.push(row.id);
  }
  expect(orphans).toEqual([]);
});

test("the allowlists only name ids that actually exist on their side", () => {
  const registryIds = new Set(Object.keys(PROVIDER_CAPABILITIES));
  const metadataIds = new Set<string>();
  for (const row of BUNDLED_PROVIDER_METADATA) metadataIds.add(row.id);

  const stale_registry = Object.keys(REGISTRY_WITHOUT_METADATA).filter(
    (id) => !registryIds.has(id) || metadataIds.has(id),
  );
  const stale_metadata = Object.keys(METADATA_WITHOUT_REGISTRY).filter(
    (id) => !metadataIds.has(id) || registryIds.has(id),
  );
  expect(stale_registry).toEqual([]);
  expect(stale_metadata).toEqual([]);
});

test("every metadata row has a baseUrl and a displayName", () => {
  const broken: Array<{ id: string; field: string }> = [];
  for (const row of BUNDLED_PROVIDER_METADATA) {
    if (row.baseUrl === undefined || row.baseUrl === "") {
      broken.push({ id: row.id, field: "baseUrl" });
    }
    if (row.displayName === undefined || row.displayName === "") {
      broken.push({ id: row.id, field: "displayName" });
    }
  }
  expect(broken).toEqual([]);
});
