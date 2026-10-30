-- Qoder native machine identity (UMID) bound to one account.
--
-- SQLite mirror of `full-postgres/0026_add_qoder_native_identity.sql`:
-- the column is `text` (the SQLite representation of jsonb) and the unique
-- index extracts the `machineToken` the same way the application reads it.
--
-- The partial unique index enforces "one device per account" at the database
-- level. SQLite supports expression indexes (3.38+); a bound identity is a
-- non-null JSON object whose `$.machineToken` is the device key.
ALTER TABLE "provider_accounts"
  ADD COLUMN "native_identity" text;

CREATE UNIQUE INDEX "provider_accounts_native_identity_token_uidx"
  ON "provider_accounts" (json_extract(native_identity, '$.machineToken'))
  WHERE native_identity IS NOT NULL;
