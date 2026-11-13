/**
 * Shared tuple-row factory for the long-tail provider catalogs.
 *
 * Every static catalog in this slice spells the same shape: a `readonly`
 * array of positional tuples (`["model-id", ctx, out, …flags]`) mapped through
 * one per-file builder that only rearranges the tuple into `defineModel`
 * fields. The rearrangement is the only thing that differs — wire family,
 * endpoint path, and which tuple slots mean vision/reasoning/document — so it
 * is declared once here as {@link CatalogRowSpec} and the catalogs keep just
 * their tuples.
 *
 * Tuple slots are opaque to this module: `translate` reads them positionally
 * and returns the `ModelHelperRow` fields they stand for (`ctx`, `out`,
 * `vision`, …). Anything the spec cannot express — a per-row wire family, a
 * free-tier flag, an endpoint override — goes in `caps`, which is spread over
 * every translated row. `defineModel`'s own fallbacks still apply to fields
 * neither side supplies, so an omitted `ctx`/`out` resolves against the base
 * catalog exactly as the hand-written builders did.
 */
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition, ModelHelperRow } from "../../provider-model-definition";

/** Everything one catalog's rows share, plus how its tuple reads. */
export interface CatalogRowSpec<T extends readonly unknown[]> {
  /** Canonical provider id for base-catalog limit/cost resolution. Omit only where the catalog historically resolved bare ids. */
  readonly providerId?: string;
  /**
   * Fields every row in this catalog shares — `wireFamily`, `endpoint`,
   * `toolCall`, `freeTier`, and any capability flag the tuple does not carry.
   */
  readonly caps: Partial<ModelHelperRow>;
  /** Reads one positional tuple into the row fields it carries. */
  readonly translate: (row: T) => Partial<ModelHelperRow>;
}

/**
 * Maps a tuple catalog through `defineModel` with the spec's shared fields.
 *
 * `modelId` always comes from `row[0]` — the tuple's first slot is the id by
 * convention — so `translate` must not return one. Spread order is
 * `caps` → `translate` → `id`/`providerId`: a tuple value wins over a shared
 * default, and neither can displace the row's identity.
 */
export function catalogRows<T extends readonly unknown[]>(
  spec: CatalogRowSpec<T>,
): (row: T) => ModelDefinition {
  return (row) =>
    defineModel({
      ...spec.caps,
      ...spec.translate(row),
      id: row[0] as string,
      ...(spec.providerId === undefined ? {} : { providerId: spec.providerId }),
    });
}
