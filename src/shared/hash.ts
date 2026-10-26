import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 of a UTF-8 string, for cache-key/identity hashing. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
