/**
 * Backup store: the public surface of the export/restore data plane.
 *
 * The implementation lives in three sibling modules along the same seams the
 * file used to have:
 * - `./codec` — cell-level encode/decode between Drizzle rows and payload JSON
 *   (dates, `bytea` secrets, sealed credentials).
 * - `./export` — the streaming export (`exportBackupStream`, `exportBackup`),
 *   gzip helpers (`compressBackup`, `compressBackupStream`, `decompressBackup`),
 *   and the tenant-ownership paging every reader shares.
 * - `./restore` — `applyRestore`, `normalizeShareChildPolicy`, and the
 *   scoped `deleteAll` sweep.
 *
 * This file only re-exports so existing importers (`./service`, `./routes`,
 * `./export-endpoint`, `./contracts`, tests) keep working unchanged.
 */
export {
  exportBackupStream,
  exportBackup,
  compressBackup,
  compressBackupStream,
  decompressBackup,
  type BackupExportStream,
} from "./export";
export {
  applyRestore,
  normalizeShareChildPolicy,
  DELETE_ALL_SCOPES,
  type DeleteAllScope,
  type DeleteAllResult,
  deleteAll,
} from "./restore";
