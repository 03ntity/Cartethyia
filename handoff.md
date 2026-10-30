# Handoff — Qoder daily check-in (100 CREDITS) + native machine identity

Status: **check-in flow fixed and verified live; item A (machine-id binding
per account + export/import) implemented and verified**. Item **B** (macOS
binary) is parked — see the end.

> Item A landed in this working tree (uncommitted). See §5a below for what
> was built and how it was verified. The sections that follow are history
> from before A was implemented; they are kept because they still explain the
> *why* of the design.

Repo root for every command below:
`D:/MyGitRepository/Projects/HoneyC/ProxyRouter-Project/Cartethyia`

---

## 1. Goal

Make the Qoder daily check-in worker actually claim the daily 100-credit grant
for every account. The campaign surface hides that grant unless the request
carries a *native machine identity* (UMID). Today the worker probes identities
per account; what is missing is **binding one identity to one account**,
persisting it, and letting the operator export/import it from provider detail.

## 2. What is already done (verified)

- [x] Desktop campaign headers in `src/providers/integrations/qoder/qoder-checkin.ts`
      (`buildCampaignHeaders`): UA `Qoder`, `cosy-clienttype: 10`, `cosy-version`
      via `getQoderVersion()`. Without them the server returns
      `showCampaign: false` and no campaigns at all.
- [x] `normalizeCampaign()` accepts the **camelCase the upstream really returns**
      (`claimStatus`, `actionType`, `campaignId`). The old code read snake_case,
      so every account resolved to `unavailable` — that was bug #1.
- [x] `src/providers/integrations/qoder/qoder-umid.ts` — spawns the native
      `runtime-info` bridge, caches identities per realm (30 min TTL), emits the
      six `cosy-machine*` headers.
- [x] **Vendored a single Linux binary**: `vendor/qoder-umid/runtime-info`
      (652,488 B, sha256 `e30b307eaae12680d2f4e220d4d34b0ea4f70355a624d6d55ee916e03f7d7478`)
      + `vendor/qoder-umid/README.md`.
- [x] `scripts/tools/extract-qoder-umid.ts` — reproducible extractor: pulls
      `@qoder-ai/qodercli` from npm, unwraps the tarball, finds the `elf-x86_64`
      blob by magic bytes, writes it idempotently (atomic replace, chmod 755).
      Verified: `bun run scripts/tools/extract-qoder-umid.ts` → "unchanged".
- [x] Binary resolution order in `qoder-umid.ts`:
      0. `vendor/qoder-umid/runtime-info` **only when `process.platform === "linux"`**
         (the filename collides with the macOS Mach-O binary, so a non-Linux host
         must not pick up the ELF).
      1. Desktop install dir (`<install>/{resources,Resources}/umid/`).
      2. `CARTETHYIA_QODER_UMID_DIR`, then `<repo>/umid`
         (win32 additionally requires `sgsdk.dll` beside it).
- [x] `probeDailyClaim()` in `qoder-checkin.ts`: tries basic headers, then each
      env identity, returns the first `claimed` / `already_claimed`, else
      `unavailable`.
- [x] Live verification (Linux identity, WSL): Ytprem's campaign list exposes
      `act-20261027-489` (`CLAIM_BENEFIT`, CREDITS 100, 30 days, ALL_MODELS).
      De-dupe is **per account**, not per OS — the same account already claimed
      from Windows shows `CLAIMED`.
- [x] Tests: `bun test test/providers/integrations/` → 30 pass / 0 fail.
      `bunx tsc --noEmit -p tsconfig.json` → clean.

## 3. Hard-won facts (do not re-derive)

1. **Identity = per-env, deterministic per hardware.** `runtime-info <env>`
   yields a stable token per `(machine, env)`. Valid env codes are only
   **0, 3, 4, 5, 6, 7** (enumerated 0–30; 1/2 and 8+ produce nothing). That is
   **6 identities per host per day**.
2. **The server filters the daily campaign by identity.** Wrong/absent identity
   → only `VIEW_DETAILS` promos, no `CLAIM_BENEFIT`. Correct one → the 100-credit
   grant appears.
3. **After a device claims, the grant is hidden for that device for the day**
   (server-side de-dupe per device). So 6 identities ⇒ at most 6 successful
   claims/day; account 7+ legitimately gets `unavailable`.
4. **`unavailable` is a legitimate outcome** ("not eligible on any slot"), not a
   worker failure. Do not retry forever.
5. **`cosy-machineid` may be the `machineToken` itself** (token-as-id works).
   No need for `auth_state.machineId`.
6. Claim semantics (from the donor hub `Public/qoder2api-hub/qoder_accounts.py:2822-2895`):
   409 / `ALREADY_CLAIMED` → `already_claimed`;
   `SAME_PERSON_ALREADY_CLAIMED` / `BLOCKED` → `not_eligible`
   ("Same-person claim already used today."); `BLOCKED` also implies a 6h
   cooldown; `REDEMPTION_CODE_OUT_OF_STOCK` → pending.
7. Endpoints:
   - `GET  https://openapi.qoder.sh/sash/api/v1/me/campaigns`
   - `POST https://openapi.qoder.sh/sash/api/v1/me/campaigns/%s/claim`
   - legacy `/sash/api/v1/me/daily-check-in/status` → **404** (dead surface).
8. Env knobs: `CARTETHYIA_QODER_UMID_DIR` (binary override),
   `CARTETHYIA_QODER_NATIVE_IDENTITY=false` (disable the bridge entirely).
   Direct `process.env.CARTETHYIA_*` reads **must** be allowlisted in
   `test/config/no-direct-env-reads.test.ts` or declared in `src/config/spec.ts`.

## 4. Files

| Path | State |
|---|---|
| `src/providers/integrations/qoder/qoder-checkin.ts` | modified |
| `src/providers/integrations/qoder/qoder-umid.ts` | **new (untracked)** |
| `test/providers/integrations/qoder-checkin.test.ts` | modified |
| `vendor/qoder-umid/{runtime-info,README.md}` | **new (untracked)** |
| `scripts/tools/extract-qoder-umid.ts` | **new (untracked)** |
| `.gitattributes` | modified (`vendor/qoder-umid/runtime-info binary`) |

Working tree is dirty on purpose; nothing is committed yet.

## 5a. Item A — implemented (2026-10-29)

All four sub-items are done and verified:

- **A1 — schema/migrations:** `provider_accounts.native_identity` jsonb
  column (`src/persistence/schema.ts`), partial unique index on extracted
  `env` (one slot per account, DB-enforced). Migrations `0026_add_qoder_native_identity.sql`
  in both `migrations/full-postgres/` and `migrations/lite-sqlite3/`; pinned
  migration list updated. `bun run check:migrations` → OK (27 migrations match
  schema). Postgres DDL proven live: duplicate `env` rejected with `23505`.
- **A2 — slot allocation:** `src/providers/integrations/qoder/qoder-native-identity-store.ts`
  (`DrizzleQoderNativeIdentityStore` get/occupied/bind +
  `allocateQoderNativeIdentity` with an in-process allocation lock). Check-in
  (`qoder-checkin.ts`) loads the bound identity first, probes it first, and
  only falls back to the enumeration when the bound identity errors; on a
  successful claim it persists the winning env (when free). Worker and console
  paths both thread the store through.
- **A3 — export/import UI:** `GET/PUT /console/api/provider-accounts/:id/native-identity`
  + `POST …/regenerate` (mounted in `account-quota.ts`, per-account auth:
  platform admin for shared accounts, tenant scope otherwise). Dashboard:
  `NativeIdentityDialog` (bound status + env, copy JSON, paste JSON import,
  regenerate) on qoder/qodercn account rows. Backup export/restore round-trip
  carries `native_identity` verbatim (new test).
- **A4 — cross-host risk:** accepted per the earlier evidence (de-dupe is per
  account, not per device); import is therefore useful. Slot uniqueness is
  still enforced per host since the bridge identity space is host-scoped.

Verification: backend suite (`bun run scripts/test/run.ts --scope backend`) and
dashboard suite + build pass; `bunx tsc --noEmit` clean for both. New tests:
`test/providers/integrations/qoder-native-identity-store.test.ts`,
`test/console/native-identity-routes.test.ts`, `test/console/backup-native-identity.test.ts`,
plus bound-identity cases in `qoder-checkin.test.ts`. Env allowlist updated for
the two qoder-umid reads.

## 5. Item A — design notes (now implemented, see §5a)

### A1. Persist the identity

Add a `native_identity` column to `provider_accounts`
(`src/persistence/schema.ts`, around line 186) holding
`{ env, machineToken, machineType, machineCode }`.

Where to put it — read these before choosing:
- `src/persistence/schema.ts:186-294` — `providerAccounts`, note `authState` is
  documented as the **non-secret** per-account upstream config that travels
  through backup/restore (`src/inferhub/key-store.ts:3-7` explains why secrets
  must *not* live there). The machine identity is **not a secret** (it is sent in
  headers in plaintext), so `auth_state` is acceptable, but a dedicated column is
  cleaner for querying "which slot is taken by whom".
- `src/console/backup/contracts.ts:145-195` — backup/restore sealing map. If you
  add a column, decide whether it is exportable; the identity **must** be
  exportable (that is the whole point of A3).
- Migrations are **hand-written**, not generated: `drizzle.config.ts` says
  `generate` would rewrite the committed SQL, and `drizzle-kit check` compares
  the schema against `migrations/full-postgres/`. `migrations/lite-sqlite3/` is a
  parallel hand-maintained set. **Both** need the new column, or `check` will
  fail on the Postgres baseline.

### A2. Slot allocation (uniqueness + reusability)

- First check-in for an account: pick an env code **not yet taken** by another
  account, run the bridge, persist `{env, machineToken, machineType, machineCode}`.
- Subsequent days: reuse the stored identity — do **not** re-probe. This is what
  makes the grant reusable per account and stops accounts from stealing slots.
- `qoder-umid.ts`: add a path that returns the stored identity instead of
  enumerating envs; keep `qoderEnvIdentities()` as the fallback when no identity
  is stored or the stored one stops working.
- `qoder-checkin.ts`: `probeDailyClaim()` should try the bound identity **first**,
  then the enumeration fallback.
- Only 6 slots per host. When all are taken, leave the account `unavailable`
  (honest, per fact #4).

### A3. Export / import from provider detail

- Console API: `GET`/`PUT` `/console/api/provider-accounts/:id/native-identity`.
  GET returns `{ env, machineToken, machineType, machineCode }` (safe to display).
  PUT accepts the same shape (paste from another instance).
- Dashboard UI on the provider-detail screen: show status (bound / unbound + env),
  a **regenerate** action (allocate a new env), **export** (copy JSON) and
  **import** (paste JSON).
- Scaffolding pointers (verify, do not trust blindly):
  - `src/console/` — route modules; `src/console/backup/9router-map.ts:153-157`
    shows how per-account router config maps into `auth_state`.
  - `src/inferhub/routes.ts:352-360` — a compact console GET handler with
    `requireGlobalAdmin(config.accessResolver(request))`; copy its response
    shape and auth pattern.
  - `src/security/crypto.ts` — AES-256-GCM sealing, layout
    `iv(12) || authTag(16) || ciphertext`. Only needed if you decide to store the
    identity sealed (probably unnecessary; it is not a secret).

### A4. Open risk to settle early

Does the server reject an identity minted on a **different** host? Evidence so
far says no (a Linux identity worked for an account whose earlier claim came
from Windows, fact: de-dupe is per account). But confirm before building the
import UI: if identities are hardware-bound, export/import is useless and the
right behaviour is auto-generate + accept `unavailable`.

## 6. Parked — item B: macOS binary

No macOS host here, so a Mach-O binary cannot be executed or verified. If picked
up: `Public/qoder2api-hub/_install_umid.py --platform darwin --arch arm64` emits
`macho-arm64` 1,026,912 B (or `macho-x86_64` 992,624 B from the same bundle's
12 candidates). That contradicts the "one binary only" decision, so it needs an
explicit go-ahead.

## 7. Test accounts

SQLite: `C:\Users\Aria\AppData\Roaming\Cartethyia\cartethyia.sqlite`
(credentials sealed with `CARTETHYIA_ENCRYPTION_KEY` from `.env`).

| id | label | note |
|---|---|---|
| `7a32ad67-98cc-4718-bbd3-129b4303273d` | anjir baru | active |
| `fd89fa4f-257d-4d24-8c77-5fa12f64e5e6` | kawa kawa | active |
| `99cae218-ee48-470b-8571-03364c79454e` | baru banget anjir | disabled |
| `407899be-09b7-43db-a10c-a387ca7c1987` | pakyu anja | disabled |
| `9b25cde2-e282-4195-a675-694754dbdb8b` | Akun Ytprem | JSON export (token redacted — kept only on the operator's desktop export) |
| `58482bef-0094-484b-a0b6-8b696e31775e` | Alma Agutah | JSON export (token redacted — kept only on the operator's desktop export) |
| `1c045bb6-d38a-40e6-9a5d-c86f20010db5` | Dimas Gurutopia | JSON export (token redacted — kept only on the operator's desktop export) |

JSON export source:
`C:\Users\Aria\Desktop\qoder-accounts-2026-10-29T12-06-21-024Z.json`

**Latest matrix (all 7 accounts × envs 0,3,4,5,6,7):** only Ytprem saw a
`CLAIM_BENEFIT` campaign (on every env — it was already claimed). Every other
account was `unavailable` on every env. That is the de-dupe/all-slots-consumed
state at the time of the run, not a regression.

## 8. Commands

```bash
# typecheck
bunx tsc --noEmit -p tsconfig.json

# tests
bun test test/providers/integrations/

# re-extract the vendored binary
bun run scripts/tools/extract-qoder-umid.ts

# run the bridge directly (Linux/WSL)
printf '{"account":"test"}\n' | vendor/qoder-umid/runtime-info 3 --account-stdin
# → {"machineToken":"P1gA…","machineType":"…","machineCode":"…","vmInfo":{…}}
```

Known env tokens on the dev box (Windows bridge): `0=P1gA-PM0XpQ…`,
`3=P1gAl67j0XM…`, `4=P1gAFcPdMSR…`, `5=P1gAVZ0yXZM…`, `6=P1gAfos3Xa9…`,
`7=P1gAQT4szbR…`. These are **host-specific** — regenerate, never hardcode.

## 9. Environment gotchas

- Windows PowerShell mangles multi-command inline snippets (`$`, `---`). Put
  anything non-trivial in a `.ps1` file and run that.
- `qoder-umid.ts` caches env identities for `IDENTITY_TTL_MS` (30 min). For
  repeated live tests use a fresh process or `resetQoderNativeIdentityCache()`.
- Scratch probe files live in `C:/Users/Aria/AppData/Local/Temp/qoder-probe/`
  (`probe.ts`, `umid/`, `umid-linux/`, `umid-mac/`, plus `.ps1` helpers). The
  repo-level `scratch-qoder-all-checkin.ts` was already deleted.
- Donor reference implementation (Python, authoritative for claim semantics):
  `D:/MyGitRepository/Projects/HoneyC/ProxyRouter-Project/Public/qoder2api-hub/`
  — `qoder_accounts.py`, `qoder_tasks.py`, `_install_umid.py`, `docs/accounts.md`.

## 10. Definition of done for A

1. Each account stores one identity; re-running check-in the same day reuses it
   and does not steal another account's slot.
2. Two accounts never share a slot.
3. `GET`/`PUT` native-identity console endpoints work; dashboard shows bound
   status and supports export/import/regenerate.
4. New/updated unit tests; `bunx tsc --noEmit` clean; both migration sets
   updated so `drizzle-kit check` passes.
