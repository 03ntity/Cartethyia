/**
 * Virtual-model table: the shared id↔roster-key lookup every integration with
 * caller-facing model names needs (Qoder, Freebuff, …).
 *
 * A virtual id is the caller-facing name; the target is the opaque roster key
 * actually dispatched upstream. The three accessors (dispatch translation,
 * membership, reverse lookup) and the display-name lookup are identical in
 * every integration that mirrors the Copilot Auto seam, so they live here and
 * each integration keeps only its own roster and overrides.
 */

/** One virtual id and the roster key it stands for. */
export interface VirtualModelEntry {
  /** The id a caller sends and the catalog publishes. */
  readonly id: string;
  /** The roster key actually dispatched upstream. */
  readonly target: string;
  /** Name shown where a human picks a model, when the integration has one. */
  readonly displayName?: string;
}

export interface VirtualModelTable {
  /**
   * Resolves a caller-supplied model id to the roster key to dispatch. A
   * non-virtual id is returned unchanged, so every existing caller and every
   * discovered row keeps working.
   */
  dispatchModelId(modelId: string): string;
  /** True when the id is a virtual name rather than a roster key. */
  isVirtualModel(modelId: string): boolean;
  /** The virtual name for a roster key, when one exists. */
  virtualIdFor(target: string): string | undefined;
  /** The display name for a virtual id, when one exists. */
  displayNameFor(id: string): string | undefined;
}

/** Builds the lookup table for one integration's virtual roster. */
export function virtualModelTable(entries: readonly VirtualModelEntry[]): VirtualModelTable {
  const targets: ReadonlyMap<string, string> = new Map(entries.map((entry) => [entry.id, entry.target]));
  const byTarget: ReadonlyMap<string, string> = new Map(entries.map((entry) => [entry.target, entry.id]));
  const displayById: ReadonlyMap<string, string> = new Map(
    entries.flatMap((entry) => (entry.displayName === undefined ? [] : [[entry.id, entry.displayName]])),
  );
  return {
    dispatchModelId: (modelId: string): string => {
      const trimmed = modelId.trim();
      return targets.get(trimmed) ?? trimmed;
    },
    isVirtualModel: (modelId: string): boolean => targets.has(modelId.trim()),
    virtualIdFor: (target: string): string | undefined => byTarget.get(target.trim()),
    displayNameFor: (id: string): string | undefined => displayById.get(id.trim()),
  };
}
