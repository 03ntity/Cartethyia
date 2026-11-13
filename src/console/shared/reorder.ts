import { ConsoleDomainError } from "./errors";

/**
 * Validates a full-replacement reorder request against the ids the tenant
 * actually has.
 *
 * Three surfaces reorder a tenant-scoped list — api keys, model aliases, model
 * combos — and each spelled out the same loop: reject an unknown id, reject a
 * duplicate, then require the list to cover every known id exactly once. The
 * check is subtle enough (a partial list must not silently renumber the rows
 * it omits) that three copies is three chances for one to drift.
 *
 * `label` names the entity in every message ("key", "alias", "combo"), so a
 * caller's error still reads the way it did before the extraction. `notFound`
 * carries the domain's own code — `key_not_found`, `unknown_alias`,
 * `unknown_combo` — because callers (and tests) match on it.
 */
export function validateReorderIds(
  ids: readonly string[],
  knownIds: ReadonlySet<string>,
  label: string,
  notFound: { readonly code: string; readonly status: number },
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!knownIds.has(id))
      throw new ConsoleDomainError(notFound.code, notFound.status, `${capitalize(label)} not found: ${id}`);
    if (seen.has(id))
      throw new ConsoleDomainError("invalid_request", 422, `Duplicate ${label} id: ${id}`);
    seen.add(id);
  }
  if (seen.size !== knownIds.size)
    throw new ConsoleDomainError(
      "invalid_request",
      422,
      `Reorder must list every ${label} exactly once`,
    );
}

/** "alias" → "Alias" for sentence-leading use in error text. */
function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
