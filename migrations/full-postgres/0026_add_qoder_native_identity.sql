-- Qoder native machine identity (UMID) bound to one account.
--
-- The daily 100-credit check-in campaign appears only when the request
-- carries a genuine, non-VM device identity. That identity is a
-- deterministic function of a seed file (`~/.config/.locale_cfg`): the
-- `runtime-info` bridge derives machineToken/machineType/machineCode from the
-- seed. Each account gets its own minted seed, so it looks like its own
-- device to the server.
--
-- The identity is not a credential (it travels in plaintext `cosy-machine*`
-- headers), so it lives unsealed as a JSON object. The partial unique index
-- on the extracted `machineToken` enforces "one device per account" at the
-- database level: two accounts sharing a token would claim as the same
-- device and the second would lose the grant for the day.
ALTER TABLE "provider_accounts"
  ADD COLUMN "native_identity" jsonb;

CREATE UNIQUE INDEX "provider_accounts_native_identity_token_uidx"
  ON "provider_accounts" ((native_identity ->> 'machineToken'))
  WHERE native_identity IS NOT NULL;
