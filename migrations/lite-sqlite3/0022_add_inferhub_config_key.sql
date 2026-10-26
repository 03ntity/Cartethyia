-- InferHub `config_read` key.
--
-- Stored on its own row rather than in `provider_accounts.auth_state`, because
-- `auth_state` is documented as the per-account non-secret upstream config and
-- travels with the account through backup/restore. This value is a credential,
-- so it lives here encrypted at rest and is reachable only through the InferHub
-- market routes.
--
-- One row for the whole deployment: the key is a single operator credential,
-- not a per-account one. `fingerprint` is a hash for change detection only —
-- it is never used to verify the key, and the plaintext is never returned.
CREATE TABLE IF NOT EXISTS inferhub_config_keys (
  id text PRIMARY KEY,
  ciphertext blob NOT NULL,
  fingerprint text NOT NULL,
  updated_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
