# Qoder Trial — Activity Claim Endpoints (unpacked IDE 1.37.0)

Findings from reversing `qoder-ide` (Linux deb, 1.37.0-1793017296) after the
`pro-upgrade/*` paths were shown to be dead (404 regardless of identity).

## The claim system behind daily credits and the welcome trial

The unpacked workbench (`out/vs/workbench/workbench.desktop.main.js`) exposes an
activity-claim API the vendor never documented, separate from the
`/sash/api/v1/me/campaigns` surface used by the daily 100:

```js
Ldn = { USER_STATUS, DATA_POLICY, LOGOUT, USER_PLAN, CREDIT_USAGE, EXPERTS_ENABLE }
HM0 = { ACTIVITY: "/algo/api/v2/activity" }                       // Inference host (api2.qoder.sh)
Rqn = {
  CLAIM_ELIGIBILITY: "/api/v2/activity/claim/eligibility",        // openapi host
  CLAIM: "/api/v2/activity/claim",                                // openapi host
  QUOTA_RESET_LATEST: "/api/v2/activity/quota/reset/latest",      // openapi host
}
mQo = { CAMPAIGNS: "/sash/api/v1/me/campaigns" }                  // daily 100 surface
```

Client flow (`QoderAuthService`):

1. `GET {Inference}/algo/api/v2/activity` → `{code:0, data:{activities:[…]}}`
   — each activity carries an `activityId`.
2. `GET {OpenApi}/api/v2/activity/claim/eligibility` → `{code:0, data:[…]}`.
3. `POST {OpenApi}/api/v2/activity/claim?activityId=<id>` → `code:0` claimed.

`claimActivity` is invoked from the credits UI only for items that appear in
**both** the activity list (eligibility intersect) — the UI never invents ids.
Literal ids found in the bundle include dev previews
(`developer-console-claim-preview`, `developer-console-reset-preview`,
`developer-preview`); real rewards are referenced by id from the activity list
response, i.e. **server-provisioned**, not client-enumerable.

## Signature schemes found (in `out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js`)

Three distinct schemes; verified empirically against `api2.qoder.sh`:

1. **COSY Bearer (RSA/AES md5 chain)** — the scheme already implemented in
   Cartethyia (`qoderSignerFor` in `src/providers/integrations/qoder/qoder.ts`).
   Confirmed working on `/algo/api/v2/activity`.
   Gotcha found: for a GET the signer must sign the **empty string** (`""`),
   not a scrambled `"{}"` body — signing `{}` while sending no body still 403s,
   and POSTing the scrambled body is rejected (`POST not supported`).
2. **Gateway HMAC "Signature" scheme** (`s8` + `addSignatureHeaders`):
   ```txt
   secret   = sha256("cosy:" + ideVersion + ":" + machineToken)   // hex
   bodyHash = sha256(String(contentLength))                       // of the LENGTH string!
   sts      = `${method} ${path} ${requestId} ${machineToken} ${ts} ${bodyHash}`
   sig      = HMAC-SHA256(secret, sts)                            // hex
   ```
   Headers sent: `X-Request-Id`, `X-Client-Timestamp`,
   `Authorization: Signature <sig>`, `X-IDE-Platform`, `X-Version`,
   `X-Machine-OS`, `X-Machine-Id`; `path` has the leading `/algo` stripped for
   signing; `requestId` is a fresh UUID. Custom headers (including
   `Authorization: Bearer dt-…`) are merged **after**, overriding
   `Authorization`. The Alaun salted telemetry variant (`salt=apm`) hashes
   `path:version:machineToken` instead.
3. **Go static headers** (`qoderStaticHeaders`): `appcode`, `date`,
   `signature = md5("cosy&<b64secret>&<date>")` — already exported/proven in
   Cartethyia.

Region config lives at `GET https://center.qoder.sh/algo/api/v2/service/region/endpoints`
→ `inferNodes: ["https://api2.qoder.sh"]`, `openapiNodes: ["https://center.qoder.sh"]`.

## Live results (30 Oct 2026)

All four locally exported accounts (Akun Ytprem, jdm fullkeknya, minted
solegit, that sepa) — tokens + desktop identity:

| Check | Result |
| --- | --- |
| `GET /api/v2/activity/claim/eligibility` | 200 `{"code":0,"msg":"ok","data":[]}` (all) |
| `GET /algo/api/v2/activity` (COSY, body="") | 200 `{"code":0,"msg":"ok","data":{"activities":[],"queryAt":…}}` (all) |
| `GET /api/v2/activity/quota/reset/latest` | 200 `{"code":0,"msg":"ok"}` |
| `POST /api/v2/activity/claim?activityId=…` | not attempted — no eligible activity ids to claim |

Interpretation: the endpoints are live and callable with our existing signer,
but **no activity is provisioned for these accounts**. The welcome
"2-week Pro trial + 300 credits" is almost certainly seeded as an activity
server-side for eligible cohorts (the fresh registration that received the
welcome email), and the client merely reveals it. This mirrors the
`GRANT_NOT_FOUND` daily-grant gap seen on `jdm fullkeknya`: provisioning is
decided server-side before the client can claim anything.

## Follow-up: provision matrix — every identity path tested (30 Oct 2026)

A fresh registration ("why sould", registered 30 Oct via browser, welcome-email
cohort) was driven through **every identity path the API exposes**; none
provisioned activities, eligibility, daily credits, or the trial:

| # | Path | Machine identity | Interaction | Result |
| --- | --- | --- | --- | --- |
| 1 | PAT → `jobToken/exchange` → chat dispatch | synthetic (PAT-hash) | 1 real turn ("hello", streamed via `agent_chat_generation`, usage 31 input tokens) | `activities []`, `eligibility []`, plan Free, quota `0 / isQuotaExceeded` |
| 2 | Native device login (this repo's `QoderOAuthClient` flow) | random UUID `machine_id` | already had #1 | unchanged — still nothing |
| 3 | Native device login with a **genuine umidpack ELF-minted** `machine_id` (`P1gA…`) | genuine SG mint | already had #1 | unchanged — still nothing |
| 4 | Same account, re-checked post-login | — | — | campaigns only `VIEW_DETAILS` banners (`act-20261021-273`, `act-20261020-944`, `benefit:null`); no `CLAIM_BENEFIT`; no trial; no 300 |

Reading: provisioning is **not** driven by (a) credential kind, (b) machine
identity shape, (c) a completed interaction, or (d) the welcome-cohort email
alone. What remains outside every replay is the desktop IDE's *full bootstrap
behavior stream* (telemetry `telemetry.sqmId`/machineId registration, the SG
SDK socket session, ArmsRum event flow) — the client does dozens of events we
do not emit, and the grant curve tracks those cohorts, exactly as suspected for
the `GRANT_NOT_FOUND` account (`jdm fullkeknya`). This closes the identity
hypothesis: the trial/daily provision surface is server-side behavioral
cohorting, and is **not reproducible headlessly today**.

Durable deliverables from the session:

- `whysould-genuine` account file on the Windows desktop carries a native
  `dt-…`, a genuine ELF identity + persisted seed — usable by the daily-claim
  pipeline whenever the account's grant window opens.
- `checkClaimEligibility`/`claimActivity` client stack, and the provision
  matrix above, settle the "is there a hidden endpoint" question definitively.

## What this closes, and what remains open

- Closes: "the trial endpoint doesn't exist in the client" — it exists; it is
  the activity-claim family above, not `pro-upgrade/*`.
- Still open: whether a server-provisioned trial activity actually appears for
  a fresh account after the promised "complete an interaction" — testable only
  on an account that is both (a) currently logged in on the desktop and (b) in
  the provisioned cohort (`buwok taikirek` received the welcome email but has
  no local machineToken yet). If it appears, the full claim is reproducible
  with `qoderSignerFor` + the three OpenApi GET/POSTs above.

## Housekeeping

A temporary request-dump hook prepended to `sharedProcessMain.js` during the
reverse session was **reverted** (byte size restored to 1317766, backup
removed).
