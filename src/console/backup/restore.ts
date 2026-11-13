/**
 * Apply path of the backup contract: restoring a validated payload and the
 * scoped delete-all sweep.
 *
 * A restore only ever touches the restoring tenant's own rows. Both the
 * export and the restore are scoped by {@link ownedByFilter}: a tenant's
 * backup contains its own configuration plus the shared rows it depends on
 * (the built-in providers and catalog), and a restore replaces only the rows
 * it owns. Shared rows are re-ensured, never deleted and never overwritten.
 * This is not a nicety — `provider_accounts` is tenant-scoped, but `providers`
 * and `models` are shared, so a table-wide `DELETE` before insert would take
 * every other tenant's accounts and the entire built-in catalog with it.
 *
 * Restore modes differ by section and the difference is load-bearing:
 * - **config** is replaced (delete the tenant's rows, then insert) — that is
 *   what "restore my configuration" means.
 * - **telemetry** is merged, never deleted. Importing history must not remove
 *   rows already present, so existing `(tenant_id, request_id, created_at)`
 *   keys are read first and duplicates are skipped, making a re-import
 *   idempotent. There is no unique constraint to lean on: `telemetry_events`
 *   has a random PK, so the natural key is checked explicitly.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { appendFile, mkdir } from "node:fs/promises";
import { getTableColumns, type Column, type SQL, type Table } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { TELEMETRY_EVENT_DIR } from "../../observability/event-log";
import { queryTelemetryEvents as querySqlEvents } from "../../observability/event-query";
import { asConsoleDb } from "../shared/transaction";
import {
  apiKeys,
  cliToolMappings,
  cliToolSettings,
  consoleSettings,
  consoleUsers,
  healthEvents,
  modelAliases,
  modelCombos,
  models,
  networkPools,
  poolRoutingSettings,
  providerAccounts,
  providerOauthStates,
  providerRoutingSettings,
  providers,
  shareLinks,
  sharePopups,
  tenantDisabledModels,
  telemetryEvents,
  telemetryUsageTotals,
} from "../../persistence/schema";
import {
  TENANT_TABLE,
  tableName,
  ownershipOf,
  replaceModeOf,
  type BackupDate,
  type BackupRow,
  type ValidatedRestore,
} from "./contracts";
import { toValues } from "./codec";
import { ownedByFilter } from "./export";

/**
 * Natural key used to detect telemetry rows that are already stored.
 *
 * Built from the payload row only. The comparison against stored rows happens
 * in SQL (see {@link existingEventFileKeys}) rather than by formatting both
 * sides in JS: the driver returns `timestamptz` through `db.execute` as a
 * string with microsecond precision and a numeric offset, which never equals
 * the ISO spelling the export wrote, so a JS-side comparison would silently
 * match nothing and every re-import would duplicate history.
 */
function telemetryKey(row: BackupRow): string {
  return `${String(row.tenant_id)}\u0000${String(row.request_id)}\u0000${createdAtIso(row.created_at)}`;
}

/** The ISO instant of an encoded date cell. */
function createdAtIso(value: unknown): string {
  if (typeof value === "object" && value !== null && "__date" in value) {
    return String((value as BackupDate).__date);
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/**
 * Reads the natural keys of telemetry rows already present for the tenants in
 * the payload, so a re-import can skip them instead of double-counting history.
 *
 * The existing rows are matched by `(tenant_id, request_id)` and their
 * timestamps are normalised in SQL to the same ISO spelling the payload uses,
 * so the two sides are comparable regardless of how the driver types them.
 */
async function existingEventFileKeys(db: CartethyiaDatabase, tenantId: string, rows: readonly BackupRow[]): Promise<Set<string>> {
  const wanted = new Set(rows.map((row) => row.request_id).filter((id): id is string => typeof id === "string"));
  if (wanted.size === 0) return new Set();
  // One indexed query for the ids being restored, instead of reading every
  // raw file to test membership. `id = request_id`, so the unique index serves
  // this directly.
  const page = await querySqlEvents(db, { tenantId, requestIds: [...wanted] });
  return new Set(
    page.events
      .map((event) => `${event.tenantId ?? ""}\u0000${event.requestId}\u0000${event.createdAt}`),
  );
}

/** Appends restored events to the file log, in the shape the writer uses. */
async function appendRestoredEvents(rows: readonly BackupRow[]): Promise<void> {
  if (rows.length === 0) return;
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
  const lines = rows.map((row) => JSON.stringify(snakeToCamelRecord(row)));
  await appendFile(`${TELEMETRY_EVENT_DIR}/restored.jsonl`, `${lines.join("\n")}\n`, "utf8");
}

function snakeToCamelRecord(row: BackupRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
    out[camel] = isDateCell(value) ? value.__date : value;
  }
  return out;
}

function isDateCell(value: unknown): value is BackupDate {
  return typeof value === "object" && value !== null && "__date" in value;
}

/**
 * Inserts a payload-shaped row into an arbitrary table.
 *
 * The values are validated against the table's real columns by {@link toValues}
 * before they get here, but Drizzle's insert builder is typed per table while
 * this module works over a `Table` chosen at runtime, so one cast is
 * unavoidable. It is confined to this helper rather than scattered across the
 * restore path.
 */
function insertRow(tx: CartethyiaDatabase, table: Table, values: Record<string, unknown>) {
  return tx.insert(table).values(values as never);
}

/**
 * Deletes the tenant's own rows from a table inside the transaction.
 *
 * Scoped by {@link ownedByFilter}, never table-wide. A table-wide delete here
 * is the bug this function exists to prevent: `providers` and `models` hold the
 * shared built-in catalog, and `provider_accounts` holds every tenant's
 * accounts, so clearing any of them would reach far outside the restoring
 * tenant.
 */
async function clearOwnedRows(
  tx: CartethyiaDatabase,
  table: Table,
  tenantId: string,
): Promise<void> {
  await tx.delete(table).where(ownedByFilter(table, tenantId));
}

/**
 * Inserts rows in bulk with a per-row fallback for diagnostics.
 *
 * `conflictTarget` is supplied for tables a restore may not delete from: the
 * payload's rows are upserted by the table's unique key, so re-importing a
 * backup updates what is already there instead of failing on the first
 * duplicate.
 *
 * Historically rows went in one statement at a time so a single bad row could
 * name its own failure. On a real backup — thousands of telemetry events, a
 * tenant's models and accounts — that cost one DB round-trip per row and the
 * restore stalled on network latency rather than the server's write path. The
 * fast path collapses those statements into one `INSERT ... VALUES (...), ...`
 * per chunk; if a chunk fails for any reason (bad row, constraint, oversized
 * parameter list) the chunk is re-run one row at a time so the diagnostic
 * surface is unchanged. The slow path is only reached on real errors, so a
 * clean restore pays zero penalty for the diagnostic.
 */
async function insertRows(
  tx: CartethyiaDatabase,
  table: Table,
  rows: readonly BackupRow[],
  options: {
    readonly skipKeys?: ReadonlySet<string>;
    readonly keyOf?: (row: BackupRow) => string;
    readonly conflictTarget?: readonly Column[];
    readonly ignoreConflicts?: boolean;
    readonly tenantId?: string;
  } = {},
): Promise<number> {
  // Normalise rows up front: filter skips, drop empty-value rows (no
  // insertable columns), and project to Drizzle values. Doing it once keeps
  // the two paths from diverging in what counts as insertable.
  const prepared: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (options.skipKeys !== undefined && options.keyOf !== undefined && options.skipKeys.has(options.keyOf(row))) {
      continue;
    }
    const values = toValues(table, row);
    if (options.tenantId !== undefined && "tenantId" in values) values.tenantId = options.tenantId;
    if (Object.keys(values).length === 0) continue;
    prepared.push(values);
  }
  if (prepared.length === 0) return 0;

  // The `set` clause for upserts: every column the payload carries is written,
  // so a re-import restores the file's state rather than leaving stale values
  // behind. `excluded` is the row that failed to insert, and column names come
  // from the schema rather than the JS key — guessing the database spelling
  // from a camelCase key breaks the moment the two differ.
  const columnNameMap = new Map(
    Object.entries(getTableColumns(table)).map(([key, column]) => [key, column.name]),
  );
  const buildUpsertSet = (values: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.keys(values).map((key) => {
        const name = columnNameMap.get(key);
        if (name === undefined) throw new Error(`${tableName(table)} has no column ${key}`);
        return [key, sql.raw(`excluded."${name}"`)];
      }),
    );

  // One row's path, kept as its own function so the bulk fallback can reuse it
  // without duplicating the control flow.
  const insertOne = async (values: Record<string, unknown>): Promise<number> => {
    const statement = insertRow(tx, table, values);
    if (options.ignoreConflicts) {
      if (options.conflictTarget === undefined) {
        throw new Error(`ignoreConflicts requires a target for ${tableName(table)}`);
      }
      const insertedRows = await statement
        .onConflictDoNothing({ target: options.conflictTarget as never })
        .returning();
      return insertedRows.length;
    }
    if (options.conflictTarget === undefined) {
      await statement;
      return 1;
    }
    await statement.onConflictDoUpdate({
      target: options.conflictTarget as never,
      set: buildUpsertSet(values) as never,
    });
    return 1;
  };

  // Bulk chunk size: keeps each statement's parameter count comfortably under
  // Postgres's 65535 limit even for the widest table. 500 rows × ~60 columns
  // leaves plenty of headroom; a narrower table just means a faster chunk.
  const BULK_CHUNK = 500;

  // Attempts one chunk in a single statement. Returns the inserted count on
  // success, or `null` to signal "fall back to per-row for this chunk". The
  // chunk is wrapped in a savepoint so a bulk failure can be rolled back
  // *inside* the outer restore transaction — without this, Postgres marks the
  // outer transaction as aborted on the first error and the per-row diagnostic
  // fallback would itself fail with "current transaction is aborted".
  const insertChunk = async (
    chunk: readonly Record<string, unknown>[],
  ): Promise<{ count: number } | { error: unknown }> => {
    try {
      // `tx.transaction(...)` nests as a `SAVEPOINT ... ROLLBACK TO SAVEPOINT`
      // on both Postgres and SQLite drivers Drizzle supports here, which is
      // exactly what the fallback needs: on failure the outer transaction
      // stays writable and the per-row path can isolate the offending row.
      const count = await tx.transaction(async (innerTx) => {
        // Drizzle types the nested transaction callback with the dialect's
        // own transaction handle; normalize once via the shared helper.
        const inner = asConsoleDb(innerTx);
        const statement = inner.insert(table).values(chunk as never);
        if (options.ignoreConflicts) {
          if (options.conflictTarget === undefined) {
            throw new Error(`ignoreConflicts requires a target for ${tableName(table)}`);
          }
          const insertedRows = await statement
            .onConflictDoNothing({ target: options.conflictTarget as never })
            .returning();
          return insertedRows.length;
        }
        if (options.conflictTarget === undefined) {
          await statement;
          return chunk.length;
        }
        // For a bulk upsert `excluded.*` references the row the driver tried
        // to insert, so each column mapping is the same regardless of which
        // row in the chunk conflicts. Build the set clause from the first
        // row's keys — every prepared row for one table carries the same key
        // set because `toValues` is deterministic for a given schema.
        const firstRow = chunk[0];
        if (firstRow === undefined) return 0;
        await statement.onConflictDoUpdate({
          target: options.conflictTarget as never,
          set: buildUpsertSet(firstRow) as never,
        });
        return chunk.length;
      });
      return { count };
    } catch (error) {
      // Signal "re-run row by row": a bulk failure must not swallow the
      // specific row's error, because the per-row path is what names the
      // offending row to the operator. Keep the bulk error too: when the
      // per-row fallback also fails (connection drop, aborted transaction,
      // oversized statement), the derived row error would otherwise hide the
      // real cause from the operator.
      return { error };
    }
  };

  let inserted = 0;
  // Group adjacent rows that share the same column key set. Different rows in
  // one table can carry different keys (an optional column omitted when the
  // payload cell is absent; `parent_key_id` present on child api_keys but not
  // parents), and Drizzle's bulk `.values([...])` compiles one SQL statement
  // with a column list taken from the first row — so a bulk of mixed shapes
  // produces malformed SQL. Grouping by signature keeps each bulk statement
  // uniform while preserving row order within the group.
  //
  // Signature is a stable `|`-joined list of sorted keys; empty columns were
  // already dropped by the `toValues` → `Object.keys(values).length === 0`
  // check above, so empty signatures never occur here.
  const signatureOf = (values: Record<string, unknown>): string =>
    Object.keys(values).sort().join("|");
  let groupStart = 0;
  while (groupStart < prepared.length) {
    const groupSignature = signatureOf(prepared[groupStart]!);
    let groupEnd = groupStart + 1;
    while (
      groupEnd < prepared.length &&
      signatureOf(prepared[groupEnd]!) === groupSignature &&
      groupEnd - groupStart < BULK_CHUNK
    ) {
      groupEnd += 1;
    }
    const chunk = prepared.slice(groupStart, groupEnd);
    const bulk = await insertChunk(chunk);
    if ("count" in bulk) {
      inserted += bulk.count;
    } else {
      // Diagnostic fallback: let the single statement that actually errors
      // reach the caller with the row that caused it. If the fallback itself
      // fails, the row-level error is derived — chain the original bulk error
      // so a connection-level fault is not reported as a bad row.
      try {
        for (const values of chunk) {
          inserted += await insertOne(values);
        }
      } catch (perRowError) {
        const bulkMessage = bulk.error instanceof Error ? bulk.error.message : String(bulk.error);
        throw new Error(
          `bulk insert into ${tableName(table)} failed (${bulkMessage}); per-row diagnostic also failed`,
          { cause: perRowError },
        );
      }
    }
    groupStart = groupEnd;
  }
  return inserted;
}

/**
 * Nulls the 11 nullable policy columns on share children owned by `tenantId`.
 *
 * Auth resolves policy from the parent (`policy = parent ?? row`), so child
 * copies of notes/limits/model_list/denylist are pure bloat. Migration 0029
 * clears them once at boot; restore does not re-run numbered migrations, so
 * an old backup that still carries populated children would reintroduce the
 * bloat unless this runs inside the same restore transaction. Keep the SET
 * list identical to migration 0029
 * (`0029_null_share_child_policy_columns.sql` in both backends) and the write
 * path in `issueSharedApiKey` (which no longer copies them).
 */
export async function normalizeShareChildPolicy(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<void> {
  // Template policy columns are nulled on every child so auth reads the full
  // policy from the parent (`policy = parent ?? row`). The exception is a
  // `per_key` concurrency child: it carries its own cap (copied at issue) and
  // its own admission identity, so `concurrency_scope` and
  // `max_concurrent_requests` are preserved for those rows.
  const policyNulls = {
    notesTitle: null,
    notesSubtitle: null,
    notesBody: null,
    requestsPerMinute: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    lifetimeTokenBudget: null,
    modelPrefix: null,
    modelList: null,
    clientRouterDenylist: null,
  };
  await db
    .update(apiKeys)
    .set({
      ...policyNulls,
      maxConcurrentRequests: null,
    })
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        isNotNull(apiKeys.parentKeyId),
        sql`${apiKeys.concurrencyScope} <> 'per_key'`,
      ),
    );
  await db
    .update(apiKeys)
    .set(policyNulls)
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        isNotNull(apiKeys.parentKeyId),
        eq(apiKeys.concurrencyScope, "per_key"),
      ),
    );
}

/**
 * Applies a pre-validated restore inside one transaction.
 *
 * `order` is children-before-parents for the config tables. The tenant row is
 * upserted first and never deleted — every tenant-scoped table cascades from
 * `tenants`, including `telemetry_events`, `telemetry_usage_totals`,
 * `console_users`, and `console_sessions`, so replacing it would destroy the
 * usage history this feature preserves and log out every console user.
 *
 * Every write is scoped to `tenantId`. A table the payload does not mention is
 * left completely alone — not cleared — so a partial import (a router export
 * carries accounts but no built-in provider rows) cannot empty the tables it
 * happens to omit. The rule is "replace what the file describes", and even then
 * only the rows this tenant owns.
 */
export async function applyRestore(
  db: CartethyiaDatabase,
  validation: ValidatedRestore,
  order: readonly Table[],
  tenantId: string,
): Promise<{ restored: Record<string, number>; skipped: Record<string, number> }> {
  const restored: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  await db.transaction(async (tx) => {
    const scoped = asConsoleDb(tx);

    // The tenant row is ensured, never replaced: it almost always exists, and
    // its PK is `id`, so a conflict means "already there" rather than an error.
    // The payload's tenant is forced to the restoring tenant — a payload naming
    // someone else's tenant id must not create or claim that tenant.
    //
    // Current exports deliberately omit the `tenants` section, so
    // `tenantRows` is normally empty. Child rows still carry
    // `tenant_id = tenantId`, which means a restore into a tenant that does
    // not exist yet would fail the `api_keys` (and other) foreign keys unless
    // we ensure the receiving tenant here. The minimal placeholder row is
    // written only for a tenant that did not already exist; on conflict it is
    // a no-op and the existing tenant's name/status are left untouched.
    if (validation.tenantRows.length > 0) {
      let inserted = 0;
      for (const row of validation.tenantRows) {
        const values = toValues(TENANT_TABLE, row);
        if (Object.keys(values).length === 0) continue;
        const result = await insertRow(scoped, TENANT_TABLE, { ...values, id: tenantId })
          .onConflictDoNothing()
          .returning({ id: sql<number>`1` });
        inserted += result.length;
      }
      restored["tenants"] = inserted;
    } else {
      const result = await insertRow(scoped, TENANT_TABLE, {
        id: tenantId,
        name: "restored",
        status: "active",
      })
        .onConflictDoNothing()
        .returning({ id: sql<number>`1` });
      restored["tenants"] = result.length;
    }

    const replaceTables = order.filter(
      (table) => validation.tables.get(table)?.mode === "replace" && table !== TENANT_TABLE,
    );
    const appendTables = order.filter(
      (table) => validation.tables.get(table)?.mode === "append",
    );

    // An empty array describes nothing, so there is nothing to replace. Clearing
    // a table because the payload mentions it with zero rows is how a restore
    // deletes data the file never spoke about: a config-only file that carries
    // `provider_accounts: []` — a router export with no connections, an export
    // taken before any account existed — would empty the tenant's accounts. The
    // file's silence is not an instruction to delete. A non-empty array still
    // replaces the tenant's rows, which is what "restore my configuration" means.
    for (const table of replaceTables) {
      const entry = validation.tables.get(table);
      if (entry === undefined || entry.rows.length === 0) continue;
      if (replaceModeOf(table) === "delete") await clearOwnedRows(scoped, table, tenantId);
    }

    // Insert parents before children.
    for (const table of [...replaceTables].reverse()) {
      const entry = validation.tables.get(table);
      if (entry === undefined) continue;
      const ownership = ownershipOf(table);
      const rows =
        table === apiKeys
          ? [...entry.rows].sort((left, right) => {
              const leftParent = left["parent_key_id"];
              const rightParent = right["parent_key_id"];
              const leftIsChild = leftParent !== null && leftParent !== undefined;
              const rightIsChild = rightParent !== null && rightParent !== undefined;
              return Number(leftIsChild) - Number(rightIsChild);
            })
          : entry.rows;
      restored[tableName(table)] = await insertRows(scoped, table, rows, {
        ...(ownership.kind === "authored" ? { conflictTarget: ownership.keyColumns } : {}),
        tenantId,
      });
    }

    // Event rows use a natural idempotency key; lifetime totals insert once per
    // identity so re-importing an older backup cannot reduce newer counters.
    for (const table of appendTables) {
      const entry = validation.tables.get(table);
      if (entry === undefined) continue;
      if (table === telemetryEvents) {
        // The payload rows are remapped to the restoring tenant before the
        // idempotency filter runs, so the dedupe keys and the appended file
        // rows are owned by the receiving tenant, not the backup's tenant.
        const remapped = entry.rows.map((row) => ({ ...row, tenant_id: tenantId }));
        const existing = await existingEventFileKeys(db, tenantId, entry.rows);
        const fresh = remapped.filter((row) => !existing.has(telemetryKey(row)));
        await appendRestoredEvents(fresh);
        restored[tableName(table)] = fresh.length;
        skipped[tableName(table)] = entry.rows.length - fresh.length;
      } else if (table === telemetryUsageTotals) {
        const restoredCount = await insertRows(scoped, table, entry.rows, {
          conflictTarget: [
            telemetryUsageTotals.tenantId,
            telemetryUsageTotals.identityType,
            telemetryUsageTotals.entityId,
          ],
          ignoreConflicts: true,
          tenantId,
        });
        restored[tableName(table)] = restoredCount;
        skipped[tableName(table)] = entry.rows.length - restoredCount;
      } else {
        restored[tableName(table)] = await insertRows(scoped, table, entry.rows, { tenantId });
      }
    }

    // Restore writes api_keys rows verbatim and does not re-run migration
    // 0029. An old backup can therefore reintroduce populated child policy
    // columns; re-apply the null-out for this tenant before committing.
    if (replaceTables.includes(apiKeys)) {
      await normalizeShareChildPolicy(scoped, tenantId);
    }
  });

  return { restored, skipped };
}

export const DELETE_ALL_SCOPES = ["providers", "proxies", "configuration"] as const;
export type DeleteAllScope = (typeof DELETE_ALL_SCOPES)[number];

export interface DeleteAllResult {
  readonly deleted: Record<string, number>;
  readonly apiKeyIds: readonly string[];
}

/**
 * Deletes selected tenant configuration scopes in one transaction. The lists
 * are explicit and ordered child-first; no table-wide delete is permitted.
 */
export async function deleteAll(
  db: CartethyiaDatabase,
  scopes: readonly DeleteAllScope[],
  tenantId: string,
): Promise<DeleteAllResult> {
  const selected = new Set(scopes);
  if (selected.size === 0) throw new Error("at least one delete scope is required");
  for (const scope of selected) {
    if (scope !== "providers" && scope !== "proxies" && scope !== "configuration") {
      throw new Error(`unknown delete scope ${scope}`);
    }
  }
  const all = selected.has("configuration");
  // `configuration` is the destructive superset: it includes provider and proxy
  // routing because those are configuration, not runtime history.
  const providersSelected = all || selected.has("providers");
  const proxiesSelected = all || selected.has("proxies");
  const deleted: Record<string, number> = {};
  const apiKeyIds: string[] = [];

  await db.transaction(async (tx) => {
    const scoped = asConsoleDb(tx);
    const remove = async (table: Table, filter: SQL, name = tableName(table)): Promise<void> => {
      const rows = await scoped.delete(table).where(filter).returning();
      if (rows.length > 0) deleted[name] = (deleted[name] ?? 0) + rows.length;
    };
    const direct = (table: Table): SQL => ownedByFilter(table, tenantId);

    if (proxiesSelected) {
      await remove(healthEvents, sql`${healthEvents.networkPoolId} in (select ${networkPools.id} from ${networkPools} where ${networkPools.tenantId} = ${tenantId})`);
      await remove(networkPools, direct(networkPools));
      await remove(poolRoutingSettings, direct(poolRoutingSettings));
    }

    if (providersSelected) {
      await remove(healthEvents, sql`${healthEvents.accountId} in (select ${providerAccounts.id} from ${providerAccounts} where ${providerAccounts.tenantId} = ${tenantId})`);
      await remove(providerOauthStates, sql`${providerOauthStates.providerAccountId} in (select ${providerAccounts.id} from ${providerAccounts} where ${providerAccounts.tenantId} = ${tenantId})`);
      await remove(providerAccounts, direct(providerAccounts));
      await remove(tenantDisabledModels, direct(tenantDisabledModels));
      await remove(models, sql`${models.providerId} in (select ${providers.id} from ${providers} where ${providers.tenantId} = ${tenantId})`);
      await remove(providerRoutingSettings, direct(providerRoutingSettings));
      await remove(providers, direct(providers));
    }

    if (all || selected.has("configuration")) {
      await remove(cliToolMappings, direct(cliToolMappings));
      await remove(cliToolSettings, direct(cliToolSettings));
      await remove(sharePopups, sql`${sharePopups.apiKeyId} in (select ${apiKeys.id} from ${apiKeys} where ${apiKeys.tenantId} = ${tenantId})`);
      await remove(shareLinks, sql`${shareLinks.apiKeyId} in (select ${apiKeys.id} from ${apiKeys} where ${apiKeys.tenantId} = ${tenantId})`);
      const keys = await scoped.delete(apiKeys).where(direct(apiKeys)).returning({ id: apiKeys.id });
      if (keys.length > 0) {
        apiKeyIds.push(...keys.map((row) => row.id));
        deleted["api_keys"] = (deleted["api_keys"] ?? 0) + keys.length;
      }
      await remove(modelAliases, direct(modelAliases));
      await remove(modelCombos, direct(modelCombos));
      await remove(consoleUsers, direct(consoleUsers));
      await remove(consoleSettings, direct(consoleSettings));
    }
  });

  return { deleted, apiKeyIds };
}
