/**
 * Streaming export of the backup contract.
 *
 * Only `tenantId`'s own rows are read. The shared rows a backup needs in order
 * to be restorable — the built-in providers and their catalog — are not carried
 * because the build already supplies them (see `seedBundledProviders` /
 * `seedBundledModels`), so a payload never contains another tenant's data.
 *
 * Exports stream: the backup of a tenant can carry hundreds of thousands of
 * rows (the dev deployment's `api_keys` held 331k minted share children), and
 * materializing the whole table to JSON it in one gulp was what OOM-killed the
 * process during a backup. Every reader is therefore paged.
 */
import { and, eq, gt, or, sql } from "drizzle-orm";
import { gzipSync, gunzipSync, createGzip } from "node:zlib";
import { differsFrom } from "../../persistence/dialect";
import { queryTelemetryEvents as querySqlEvents } from "../../observability/event-query";
import type { TelemetryEventRecord } from "../../observability/event-log";
import { getTableColumns, type Column, type SQL, type Table } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import {
  providerAccounts,
  providerOauthStates,
  telemetryEvents,
} from "../../persistence/schema";
import {
  BACKUP_APP,
  BACKUP_VERSION,
  CONFIG_TABLES,
  MAX_BACKUP_DECOMPRESSED_BYTES,
  MAX_ROWS_PER_TABLE,
  TELEMETRY_TABLES,
  ownershipOf,
  tableName,
  type BackupPayloadExport,
  type BackupPayload,
  type BackupRow,
} from "./contracts";
import { encodeRow } from "./codec";
import { pickDefined } from "../shared/object";

/**
 * The predicate that selects exactly the rows `tenantId` owns in `table`.
 *
 * `viaParent` reads as a subquery on the parent's owner column, so a model row
 * is the tenant's exactly when its provider is. `authored` adds the second
 * arm: a row whose `source` is not the value the build stamps is the tenant's
 * own work even when it sits under a shared provider. A `NULL` owner — a
 * built-in provider, a pool-wide account — never satisfies `= tenantId`, which
 * is what keeps the shared catalog out of a tenant's restore.
 *
 * The second arm is scoped to a **shared** parent on purpose. "Not
 * reproducible from the build" alone is not evidence of authorship: another
 * tenant's provider can also carry a probed model, and reading it into this
 * tenant's backup would both leak that tenant's catalog and produce a restore
 * that inserts a `models` row whose `provider_id` this tenant does not own —
 * a foreign-key violation. Authorship therefore requires that the row hangs
 * off a provider nobody owns, or off this tenant's own provider.
 */
export function ownedByFilter(table: Table, tenantId: string): SQL {
  const ownership = ownershipOf(table);
  if (ownership.kind === "viaParent") {
    const parentOwner = ownershipOwnerColumn(ownership.parent);
    return sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} = ${tenantId})`;
  }
  if (ownership.kind === "authored") {
    const parentOwner = ownershipOwnerColumn(ownership.parent);
    const mine = sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} = ${tenantId})`;
    const shared = sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} is null)`;
    const unreproducible = differsFrom(sql`${ownership.authoredColumn}`, sql`${ownership.reproducibleValue}`);
    return sql`(${mine} or (${shared} and ${unreproducible}))`;
  }
  return eq(ownership.column, tenantId);
}

/** The column that carries a parent table's owner, for the `viaParent` subquery. */
function ownershipOwnerColumn(parent: Table): Column {
  const ownership = ownershipOf(parent);
  if (ownership.kind === "direct" || ownership.kind === "self") return ownership.column;
  // A parent that is itself owned through another parent would need a second
  // join level. No table in the contract has one; refuse rather than build a
  // filter that silently matches nothing (or everything).
  throw new Error(
    `${tableName(parent)} is not directly tenant-owned, so ownership cannot be resolved one level up`,
  );
}

const EXPORT_PAGE_ROWS = 500;

/**
 * The composite keys of tables whose primary key is not declared column-wise.
 * Row tables stream through a keyset walk, so the sort key must uniquely
 * order rows — a truncated key would swallow tied rows at every page
 * boundary.
 */
const COMPOSITE_KEYSETS: Partial<Record<string, readonly string[]>> = {
  telemetry_usage_totals: ["tenantId", "identityType", "entityId"],
  cli_tool_settings: ["tenantId", "apiKeyId", "toolId"],
  provider_routing_settings: ["providerId", "tenantId"],
};

/**
 * The key a keyset walk of `table` pages by, or `null` for a table whose rows
 * are contract-bounded to a handful (per-tenant settings singletons) and are
 * read in one statement.
 */
function keysetKey(table: Table): readonly Column[] | null {
  const name = tableName(table);
  const columns = getTableColumns(table) as Record<string, Column>;
  const composite = COMPOSITE_KEYSETS[name];
  if (composite !== undefined) {
    return composite.map((key) => {
      const column = columns[key];
      if (column === undefined) throw new Error(`${name}: backup keyset names missing column ${key}`);
      return column;
    });
  }
  // Single keys: a uuid `id` first, then the per-table natural keys
  // (`provider_oauth_states` → its account, `share_popups` → its template).
  // `tenantId` is last: it is the primary key of nothing but the per-tenant
  // settings singletons, so single-column `id` always wins where one exists.
  for (const single of ["id", "providerAccountId", "apiKeyId", "tenantId"] as const) {
    const column = columns[single];
    if (column !== undefined) return [column];
  }
  return null;
}

/** Rows past the key of the previous page, in the key's own order. */
function keysetAfter(key: readonly Column[], last: readonly unknown[]): SQL {
  return or(
    ...key.map((column, index) =>
      and(...key.slice(0, index).map((prior, at) => eq(prior, last[at])), gt(column, last[index])),
    ),
  ) as SQL;
}

/** Yields the owned rows of `table` in key order, one statement per page. */
export async function* pagedRows(
  db: CartethyiaDatabase,
  table: Table,
  tenantId: string,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const filter = ownedByFilter(table, tenantId);
  const key = keysetKey(table);
  if (key === null) {
    const rows = (await db
      .select()
      .from(table)
      .where(filter)
      .limit(MAX_ROWS_PER_TABLE)) as Array<Record<string, unknown>>;
    yield* rows;
    return;
  }
  const entries = Object.entries(getTableColumns(table));
  const keyNames = key.map((column) => {
    const entry = entries.find(([, candidate]) => candidate === column);
    if (entry === undefined) throw new Error(`${tableName(table)}: key column is not part of the table`);
    return entry[0];
  });
  let last: unknown[] = [];
  while (true) {
    const where = last.length === 0 ? filter : and(filter, keysetAfter(key, last));
    const rows = (await db
      .select()
      .from(table)
      .where(where)
      .orderBy(...key.map((column) => sql`${column} asc`))
      .limit(EXPORT_PAGE_ROWS)) as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    yield* rows;
    if (rows.length < EXPORT_PAGE_ROWS) return;
    const tail = rows[rows.length - 1] as Record<string, unknown>;
    last = keyNames.map((name) => tail[name]);
  }
}

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/** Encodes one telemetry event row the way `exportEventFile` used to. */
function telemetryRowOf(event: TelemetryEventRecord): BackupRow {
  const row: BackupRow = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === null || value === undefined) continue;
    row[camelToSnake(key)] = key === "createdAt" ? { __date: String(value) } : value;
  }
  return row;
}

async function* pagedTelemetryEvents(
  db: CartethyiaDatabase,
  tenantId: string,
): AsyncGenerator<TelemetryEventRecord, void, void> {
  // The SQL table is the durable record now, and it is tenant-scoped and
  // retained by the same rule as the raw files — so the export walks it
  // newest-first through its own keyset cursor instead of scanning every raw
  // file and filtering by tenant afterwards.
  let cursor: string | undefined;
  while (true) {
    const page = await querySqlEvents(db, {
      tenantId,
      limit: EXPORT_PAGE_ROWS,
      ...pickDefined({ cursor }),
    });
    yield* page.events;
    if (page.nextCursor === undefined) return;
    cursor = page.nextCursor;
  }
}

/**
 * Adds the `providerConnections` block a router export carries.
 *
 * The row tables above are the restore path; this block is the interchange
 * shape another Cartethyia install (or a router migration) reads accounts from,
 * so it keeps its own field names — `accessToken`, not
 * `credential_ciphertext`. Both are built from the same decrypted values, so
 * there is one decode and two projections of it rather than a second read.
 */
function attachOauthSecrets(
  config: Record<string, readonly BackupRow[]>,
): readonly Record<string, unknown>[] | undefined {
  const accounts = config.provider_accounts;
  const states = config.provider_oauth_states;
  if (!Array.isArray(accounts)) return undefined;
  const byAccount = new Map((states ?? []).map((state) => [String(state.provider_account_id), state]));
  return accounts.map((account) => {
    const state = byAccount.get(String(account.id));
    return {
      id: account.id,
      provider: account.provider_id,
      authType: account.credential_kind,
      name: account.label,
      accessToken: account.access_token ?? null,
      refreshToken: state?.refresh_token ?? null,
      clientSecret: state?.client_secret ?? null,
      expiresAt: dateText(state?.expires_at),
      isActive: account.status === "active",
      createdAt: dateText(account.created_at),
      providerSpecificData: account.auth_state ?? {},
    };
  });
}

function dateText(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("__date" in value)) return null;
  const date = value.__date;
  return typeof date === "string" ? date : null;
}

/**
 * Streams the payload document: the requested tables, grouped into their
 * sections, written incrementally so the process never holds a table — let
 * alone every table and a second JSON copy — in memory. Consumed chunks
 * concatenated are exactly the JSON the buffered variant used to stringify in
 * one piece.
 */
async function* backupJsonChunks(
  db: CartethyiaDatabase,
  tables: readonly Table[],
  tenantId: string,
  finishCounts: (counts: Record<string, number>) => void,
): AsyncGenerator<string, void, void> {
  const counts: Record<string, number> = {};

  const configSet = new Set<Table>([...CONFIG_TABLES]);
  const telemetrySet = new Set<Table>(TELEMETRY_TABLES);
  const configTables = tables.filter((table) => configSet.has(table));
  const telemetryTables = tables.filter((table) => telemetrySet.has(table));
  const outside = tables.filter((table) => !configSet.has(table) && !telemetrySet.has(table));

  // The OAuth projection is derived from the accounts block itself, so those
  // two tables materialize (both are operator-sized, dozens of rows) instead
  // of being read twice.
  const materialized = new Map<Table, readonly BackupRow[]>();
  const materializedRows = async (table: Table): Promise<readonly BackupRow[]> => {
    let rows: readonly BackupRow[] | undefined = materialized.get(table);
    if (rows === undefined) {
      const built: BackupRow[] = [];
      for await (const source of pagedRows(db, table, tenantId)) {
        built.push(encodeRow(table, source));
      }
      rows = built;
      materialized.set(table, rows);
    }
    return rows;
  };

  /** Writes one table's array into the document, tracking the exported count. */
  async function* writeTable(table: Table, sources?: readonly BackupRow[]): AsyncGenerator<string, void, void> {
    const name = tableName(table);
    let first = true;
    let written = 0;
    yield `"${name}":[`;
    if (sources === undefined) {
      for await (const source of pagedRows(db, table, tenantId)) {
        if (written >= MAX_ROWS_PER_TABLE) break;
        yield `${first ? "" : ","}${JSON.stringify(encodeRow(table, source))}`;
        first = false;
        written += 1;
      }
    } else {
      for (const row of sources) {
        yield `${first ? "" : ","}${JSON.stringify(row)}`;
        first = false;
        written += 1;
      }
    }
    yield "]";
    counts[name] = written;
  }

  try {
    yield `{"app":${JSON.stringify(BACKUP_APP)},"version":${BACKUP_VERSION},"exportedAt":${JSON.stringify(new Date().toISOString())},"sections":{`;
    if (configTables.length > 0) {
      yield `"config":{`;
      let configIndex = 0;
      for (const table of configTables) {
        const sources =
          table === providerAccounts || table === providerOauthStates ? await materializedRows(table) : undefined;
        yield configIndex > 0 ? "," : "";
        yield* writeTable(table, sources);
        configIndex += 1;
      }
      yield `}`;
    }
    if (telemetryTables.length > 0) {
      let telemetryIndex = 0;
      for (const table of telemetryTables) {
        if (telemetryIndex === 0) {
          yield `${configTables.length > 0 ? "," : ""}"telemetry":{`;
        } else {
          yield ",";
        }
        telemetryIndex += 1;
        if (table === telemetryEvents) {
          yield `"${tableName(table)}":[`;
          let first = true;
          let written = 0;
          for await (const event of pagedTelemetryEvents(db, tenantId)) {
            if (written >= MAX_ROWS_PER_TABLE) break;
            yield `${first ? "" : ","}${JSON.stringify(telemetryRowOf(event))}`;
            first = false;
            written += 1;
          }
          yield "]";
          counts[tableName(table)] = written;
        } else {
          yield* writeTable(table);
        }
      }
      yield `}`;
    }
    yield `}`;
    // Tables that belong to neither section (the tenant row) are counted but
    // do not enter the payload — the same rule the buffered assembly kept.
    for (const table of outside) {
      let written = 0;
      for await (const _source of pagedRows(db, table, tenantId)) {
        written += 1;
      }
      counts[tableName(table)] = written;
    }
    // Always built: the row tables above now always carry the credentials
    // decrypted, so the projection is always complete. It used to be
    // conditional on the export being "raw", which made a plain JSON export
    // carry a block of null tokens — a router migration from it produced
    // accounts with no credential at all.
    if (materialized.size > 0) {
      const inputs: Record<string, readonly BackupRow[]> = {};
      const accounts = materialized.get(providerAccounts);
      const states = materialized.get(providerOauthStates);
      if (accounts !== undefined) inputs["provider_accounts"] = accounts;
      if (states !== undefined) inputs["provider_oauth_states"] = states;
      const providerConnections = attachOauthSecrets(inputs);
      if (providerConnections !== undefined) {
        yield `,"providerConnections":${JSON.stringify(providerConnections)}`;
      }
    }
    yield `}`;
  } finally {
    finishCounts(counts);
  }
}

export interface BackupExportStream {
  /** Concatenated chunks are the payload document, one string at a row-page granularity. */
  readonly jsonChunks: AsyncGenerator<string, void, void>;
  /**
   * Row counts per table, resolved once the document has been consumed to
   * completion — a streamed export counts what it actually wrote.
   */
  readonly counts: Promise<Record<string, number>>;
}

export function exportBackupStream(
  db: CartethyiaDatabase,
  tables: readonly Table[],
  tenantId: string,
): BackupExportStream {
  let resolveCounts!: (counts: Record<string, number>) => void;
  const counts = new Promise<Record<string, number>>((resolve) => {
    resolveCounts = resolve;
  });
  return {
    jsonChunks: backupJsonChunks(db, tables, tenantId, resolveCounts),
    counts,
  };
}

/**
 * The buffered form of {@link exportBackupStream}: builds the whole payload
 * object in memory. Export callers stream; this remains for callers that need
 * the payload as data — the backup round-trip tests use it to feed restores.
 */
export async function exportBackup(
  db: CartethyiaDatabase,
  tables: readonly Table[],
  tenantId: string,
): Promise<BackupPayloadExport> {
  const stream = exportBackupStream(db, tables, tenantId);
  let document = "";
  for await (const chunk of stream.jsonChunks) document += chunk;
  return { counts: await stream.counts, payload: JSON.parse(document) as BackupPayload };
}

/**
 * Gzips a backup payload.
 *
 * `compressed` is a property of the *file*, and of nothing else: the payload is
 * the same object either way. It used to also mean "decrypt the credentials",
 * which coupled a transport choice to a security decision and left the plain
 * JSON export carrying ciphertext no other install could open.
 */
export function compressBackup(payload: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
}

/**
 * Gzips a streamed payload assembly: one pass, no whole-document buffer of
 * the raw JSON (the compressed document itself still fits one buffer, since
 * the response contract wraps it as base64).
 */
export async function compressBackupStream(chunks: AsyncGenerator<string, void, void>): Promise<Buffer> {
  const gzip = createGzip();
  const parts: Buffer[] = [];
  const finished = new Promise<"done" | Error>((resolve) => {
    gzip.on("data", (chunk: Buffer) => parts.push(chunk));
    gzip.on("error", (error: Error) => resolve(error));
    gzip.on("end", () => resolve("done"));
  });
  for await (const chunk of chunks) {
    await new Promise<void>((resolve, reject) => {
      gzip.write(Buffer.from(chunk, "utf8"), (error) => (error === null ? resolve() : reject(error)));
    });
  }
  gzip.end();
  const outcome = await finished;
  if (outcome !== "done") throw outcome;
  return Buffer.concat(parts);
}

/** The gzip magic, so a file can be recognised without trusting its name. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** Whether `bytes` starts with the gzip magic. */
function isGzipBytes(bytes: Uint8Array): boolean {
  return GZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Undoes {@link compressBackup}.
 *
 * A restore has to accept the file the export actually produces. The dashboard
 * offers a compressed download and names it `.json.gz`, and until now that file
 * could not be restored at all: the import path read the body as JSON text and
 * `JSON.parse` of gzip bytes fails, so the operator's own backup — the only one
 * they had — was rejected as "not a JSON backup".
 *
 * A file that is not gzipped is returned unchanged rather than refused, because
 * a plain `.json` export is equally restorable and the bytes are the only thing
 * that distinguishes them.
 *
 * Decompression is bounded by {@link MAX_BACKUP_DECOMPRESSED_BYTES}: a gzip
 * bomb (a few MiB of repeated bytes inflating to gigabytes) must fail as a
 * clean, sized error rather than allocating until the process dies. The bound
 * is far above what a real backup expands to, so only a hostile or corrupt
 * file can reach it.
 */
export function decompressBackup(bytes: Uint8Array): string {
  if (!isGzipBytes(bytes)) return Buffer.from(bytes).toString("utf8");
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_BACKUP_DECOMPRESSED_BYTES }).toString("utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hitOutputBound =
      (error instanceof Error && error.name === "RangeError") ||
      (typeof (error as { code?: unknown } | null)?.code === "string" &&
        (error as { code: string }).code === "ERR_BUFFER_TOO_LARGE") ||
      /memory limit/i.test(message);
    throw new Error(
      hitOutputBound
        ? `that gzip backup decompresses beyond the ${MAX_BACKUP_DECOMPRESSED_BYTES} byte limit; it is either corrupt or not a real backup`
        : `that file is named or marked as gzip but could not be decompressed: ${message}`,
    );
  }
}
