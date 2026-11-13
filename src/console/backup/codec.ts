/**
 * Cell-level codec for the backup payload contract.
 *
 * Encoding rules are driven by the column's Drizzle `dataType` rather than a
 * hand-written per-column table, so a new column cannot be forgotten:
 * - `date` → `{ __date: ISO }`. JSON has no date; a bare string would come back
 *   as text and Postgres would have to guess.
 * - `custom` (our `bytea` columns: encrypted credentials) → `{ __bytes: base64 }`.
 *   Postgres returns a `Buffer`, and `JSON.stringify` renders that as
 *   `{"type":"Buffer","data":[…]}` — large, and it silently "works" on import
 *   while misrepresenting the type.
 * - everything else is already JSON-safe (string, number, boolean, json, null).
 *
 * A sealed column exports as its **plaintext** (see `sealedColumns` in
 * `./contracts` for why the ciphertext must not travel), and a restore re-seals
 * it under this install's key via {@link sealSecret}. This module owns both
 * directions of that projection plus the column-index cache every table walk
 * shares.
 */
import { getTableColumns, type Table } from "drizzle-orm";
import { decryptCredentialToString, encryptCredential } from "../../security/crypto";
import {
  columnNames,
  payloadNameOf,
  sealedColumns,
  tableName,
  type BackupBytes,
  type BackupDate,
  type BackupRow,
} from "./contracts";

/** The driver's `Buffer` view of a `bytea` cell, or null when it holds none. */
export function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

/**
 * A sealed column, as the payload carries it: the plaintext.
 *
 * The ciphertext is deliberately *not* what travels — see
 * {@link sealedColumns} for why. Ciphertext this install's key cannot open
 * (sealed before a key rotation, or copied in from another install's database)
 * exports as null rather than as its bytes: writing those bytes as text would
 * put an unopenable string in the file, which a restore would then re-seal as
 * though it were the secret itself.
 */
export function decodeSealedForPayload(value: unknown): string | null {
  const bytes = toBuffer(value);
  if (bytes === null) return null;
  try {
    return decryptCredentialToString(bytes);
  } catch {
    return null;
  }
}

/** Encodes one cell into a JSON-safe value. */
export function encodeCell(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "date") {
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime())
      ? null
      : ({ __date: date.toISOString() } satisfies BackupDate);
  }
  if (dataType === "custom") {
    const bytes = toBuffer(value);
    if (bytes === null) return null;
    return { __bytes: bytes.toString("base64") } satisfies BackupBytes;
  }
  return value;
}

/** Decodes one payload cell back to what the driver expects for that column. */
export function decodeCell(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "date") {
    const raw =
      typeof value === "object" && value !== null && "__date" in value
        ? (value as BackupDate).__date
        : String(value);
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new Error(`invalid date value: ${raw}`);
    return date;
  }
  if (dataType === "custom") {
    if (typeof value === "object" && value !== null && "__bytes" in value) {
      return Buffer.from((value as BackupBytes).__bytes, "base64");
    }
    if (typeof value === "string") return Buffer.from(value, "base64");
    throw new Error("a byte column must be a base64 string or a { __bytes } object");
  }
  return value;
}

/** Column name → the object key Drizzle uses for it, and its data type. */
const COLUMN_INDEX_CACHE = new WeakMap<Table, ReadonlyMap<string, { key: string; dataType: string }>>();
export function columnIndex(table: Table): ReadonlyMap<string, { key: string; dataType: string }> {
  const cached = COLUMN_INDEX_CACHE.get(table);
  if (cached) return cached;
  const out = new Map<string, { key: string; dataType: string }>();
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    out.set(column.name, { key, dataType: column.dataType });
  }
  COLUMN_INDEX_CACHE.set(table, out);
  return out;
}

/** Encodes one read row for the payload. */
export function encodeRow(table: Table, row: Record<string, unknown>): BackupRow {
  const index = columnIndex(table);
  const sealed = sealedColumns(table);
  const out: BackupRow = {};
  for (const [name, { key, dataType }] of index) {
    // A sealed column is written decrypted, under the name of the secret it
    // holds — see `SEALED_COLUMNS` for why the column's own name would be a
    // lie in a file that no longer carries its ciphertext.
    out[payloadNameOf(table, name)] = sealed.has(name)
      ? decodeSealedForPayload(row[key])
      : encodeCell(row[key], dataType);
  }
  return out;
}

/**
 * Re-seals one secret column under **this** install's key.
 *
 * The payload carries the plaintext (see {@link sealedColumns}), so every
 * restore writes ciphertext the importing install can actually open. This is
 * the step whose absence destroyed the receiving install's credentials: the
 * file's bytes were inserted verbatim after the install's own rows had been
 * deleted, so the restored configuration held secrets sealed under a key that
 * was not in the room.
 *
 * A null cell is null again — every sealed column is nullable, and "this
 * account has no stored credential" is a state the schema has to represent.
 * Validation drops any other non-string cell before it gets here, so a
 * non-string is a contract break rather than a case to coerce.
 */
export function sealSecret(value: unknown, table: string, column: string): Buffer | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`${table}.${column} must be restored as a plaintext string, got ${typeof value}`);
  }
  return encryptCredential(value);
}

/** Builds a Drizzle row object from a payload row, coercing each cell. */
export function toValues(table: Table, row: BackupRow): Record<string, unknown> {
  const index = columnIndex(table);
  const allowed = columnNames(table);
  const sealed = sealedColumns(table);
  const name = tableName(table);
  const values: Record<string, unknown> = {};
  for (const [column, cell] of Object.entries(row)) {
    if (!allowed.has(column)) throw new Error(`${name}.${column} is not a known column`);
    const entry = index.get(column);
    if (entry === undefined) continue;
    values[entry.key] = sealed.has(column)
      ? sealSecret(cell, name, column)
      : decodeCell(cell, entry.dataType);
  }
  return values;
}
