# Proposal — Tenant "Inject System Prompt" (append / override) tanpa merusak prompt bawaan provider

Status: **DRAFT v2 — untuk review**
Scope: desain backend + migration DB + wiring UI untuk slot **Inject System Prompt** di Overview (sekarang masih UI-only, session-local).

**Keputusan review yang sudah masuk (v1 → v2):**
1. Buddy **bisa** di-append — dengan **awalan + akhiran prompt kita** (marker gateway) membungkus teks tenant.
2. Semantik `override`: **keputusan implementer** — menanggalkan system caller saja; prompt native provider tetap hidup.
3. Persistensi: tabel dedicated **migration 0031**, dengan **toggle per-provider `follow global` vs custom**.
4. Cap ukuran: **5 MB** per scope.

---

## 1. Masalah

Banyak provider/integration punya **system prompt bawaan yang di-validate upstream** — bagian dari kontrak wire (identity/gating). Fitur tenant "Inject System Prompt" tidak boleh menyentuhnya kecuali lewat jalur yang upstream toleransi.

### 1.1 Hasil audit per provider

| Provider | Prompt bawaan | Perilaku adapter | File |
|---|---|---|---|
| **Claude (Claude Code OAuth)** | Billing attestation `x-anthropic-billing-header: …` (byte-faithful, SHA-256 over first-user-text) + `"You are Claude Code, …"` | **PREPEND** 2 blok ke `payload.system`; caller system dipertahankan **setelahnya**; cache breakpoint ephemeral 1h di blok **terakhir** | `src/providers/integrations/claude/claude.ts` L302–352, `claude-cch.ts` L124–142 |
| **Buddy family** (CodeBuddy `cb`, CodeBuddyCN `cbcn`, WorkBuddy) | `CODEBUDDY_SYSTEM_PROMPT` / `WORKBUDDY_SYSTEM_PROMPT` / CN neutralizer | **REPLACE total** — caller `system`/`developer` dibuang, satu system turn fixed. Upstream memvalidasi teks prompt sebagai channel identity: substitusi teks caller → `400 · 11-128`; `developer` turn ditolak; system kosong → `11151` | `buddy-chat-shared.ts` header L1–40, `applyBuddySystemPrompt` L1149–1186 |
| **Antigravity** | `ANTIGRAVITY_SYSTEM_INSTRUCTION` | **PREPEND** ke `systemInstruction.parts`, idempotent, caller parts dipertahankan | `antigravity.ts` L791–792, L948–968 |
| **OpenCode (free)** | Marker + `<env>` block (gate free tier) | **APPEND-preserving & idempotent** di chat/messages/responses | `opencode/prompt.ts` L19–22, L102–111 |
| **Kiro** | Tidak ada field `system` (top-level `systemPrompt` ditolak) | System text di-fold ke **first user turn** (`buildStablePrefix()`) — byte-stable prefix yang di-cache | `kiro-request.ts` L12–13, L195–214 |
| **Cursor** | Tidak inject; system caller → global rule `cartethyia/system-instructions` | passthrough | `cursor-request.ts` L142–158 |
| **Cline / Qoder** | Tidak punya persona (Qoder menggabungkan ke satu `systemPrompt`) | passthrough/mirror | `cline.ts` L88–135, `qoder.ts` L702–727 |
| **Kilo, Droid, Copilot, Continue, Roo, Amp** | Bukan integration — CLI-config injector | tidak menyentuh system prompt | `src/console/cli-tools/injectors/*` |
| **System One** (`serviceKind: "systemone"`) | Native decision protocol | skip fitur | `src/transport/dispatch/systemone.ts` |

### 1.2 Kesimpulan audit

- Prompt native provider adalah **hard contract** — kecuali Buddy, yang upstream-nya ternyata **menoleransi tambahan teks setelah prompt identity** selama prompt identity utuh dan tetap menjadi pembuka (keputusan review: Buddy bisa di-append dengan pembungkus awalan+akhiran kita).
- Yang bebas dilanggar hanyalah system content **caller** — itu milik tenant.
- Konsekuensi desain: transform tenant jalan **di level canonical, sebelum adapter**; adapter hanya disentuh di satu titik (Buddy), dan hanya untuk meneruskan teks tenant.

---

## 2. Titik sisip di pipeline

```
preparer.ts (auth → continuation affinity → degradation → plan)
  → dispatch/proxy-request.ts L117: applyTenantPreferences(prepared, db)     ← SEAM (canonical, wire-agnostic)
        thinking normalize → RTK prune → [BARU: inject system prompt] → PonyTail (terakhir)
  → runAttemptLoop → adapter
        → wire codec (messages/chat/responses/gemini/codex/kiro)
        → adapter hooks (claude prepend, buddy replace, antigravity prepend, dst.)
```

Fakta pendukung:
- Canonical `system[]` + `instructions[]` — ordered arrays, multiple parts legal (`canonical-model.ts` L517–520).
- PonyTail (`rtk/compress-request.ts` L117–125) = pola referensi: append idempotent, non-fatal, ordered terakhir. Transform baru disisipkan **sebelum** PonyTail.
- `deriveConversationAffinity` hash 30+ char pertama `request.system` (`session-resolution.ts` L29–56): teks tenant statis per scope → aman.
- Anthropic menempel cache breakpoint di blok system **terakhir** (`claude.ts` L333–351): teks tenant yang di-append menerima breakpoint → harus byte-stable per percakapan (teks scope = konstanta tersimpan → terpenuhi).
- Kiro: teks tenant ikut ter-fold ke stable prefix — aman (statis).

---

## 3. Desain fitur

### 3.1 Scope & precedence (most-specific-wins)

1. **Model** (`providerId::modelId`)
2. **Provider** (`providerId`)
3. **Global**

Scope paling spesifik yang aktif dipakai; yang kalah **tidak** digabung. Resolusi untuk provider mengenal **dua posisi** (lihat §3.4): `follow global` (pakai prompt global tenant) atau `custom` (prompt sendiri).

### 3.2 Mode — `append` (default) & `override`

- **`append`**: `request.system = [...caller system, ...caller instructions, ...hoisted system, tenantText]`. Identity provider tetap paling depan (di-prepend adapter), teks tenant paling belakang.
- **`override`**: `request.system = [tenantText]` — menanggalkan **system caller saja**. Prompt native provider tetap di-inject adapter setelahnya (mereka bekerja di layer wire dan tidak tahu transform ini), sehingga request Claude/Antigravity/buddy tetap valid. Override bukan "telanjang".

### 3.3 Aturan per provider

| Provider | Keputusan |
|---|---|
| `serviceKind !== "llm"` (systemone dst.) | **Skip** — transform tidak jalan. |
| **Buddy family** | **Append dengan pembungkus gateway.** Prompt identity Buddy tetap menjadi pembuka system turn (utuh, tidak diubah — syarat `11-128`), teks tenant disisipkan **setelahnya dalam turn yang sama**, dibungkus **awalan + akhiran prompt kita**: `<cartethyia:system-prompt> … </cartethyia:system-prompt>`. Upstream memvalidasi identity pembuka, bukan ekor turn (keputusan review; tetap kualifikasi live-test saat F3). Implementasi: parameter `extraSystemText` baru di `applyBuddySystemPrompt` yang digabung `systemPrompt + "\n\n" + prefix + tenant + suffix` — satu-satunya perubahan adapter. |
| **Claude** | Append biasa. Tidak ada perubahan adapter; billing attestation tersentuh; breakpoint menempel di teks tenant (statis → aman). |
| **Kiro** | Append biasa (ter-fold ke stable prefix). |
| **Antigravity / OpenCode / Cursor / Cline / Qoder / Codex** | Append biasa — semua append-preserving / ter-fold aman. |

### 3.4 Posisi provider: `follow global` vs custom

Per provider ada **toggle**:
- **`follow global` (default)** — provider menerima prompt global tenant (mode & teks dari Global).
- **`custom`** — provider punya mode + teks sendiri (dan model-model di bawahnya bisa override lagi per-model).

Ini yang membuat tabel sederhana: prompt di-resolve **global → provider → model**, dan provider hanya "punya suara sendiri" kalau toggle-nya custom.

### 3.5 Guard

- Cap ukuran teks: **5 MB** per scope (validated di console route, ditolak 413/400 di atasnya; juga jaga body-limit route).
- Semua transform non-fatal (try/catch) sesuai kontrak `tenant-preferences.ts`.
- Idempotency: marker check seperti PonyTail (plus marker `cartethyia:system-prompt` untuk Buddy) agar retry tidak menggandakan.

---

## 4. Persistensi — **migration 0031** (tabel dedicated)

Prompt multi-scope = data operator besar (sampai 5 MB/scope) dan berlapis — JSONB bag `console_settings` tidak tepat. Tabel dedicated, satu row per tenant:

### 4.1 `migrations/full-postgres/0031_tenant_system_prompts.sql`

```sql
-- Tenant-scoped system prompt injection (append/override).
--
-- Resolution is most-specific-wins: model > provider > global. A provider
-- either follows the tenant's global prompt (follow_global = true, its own
-- columns are ignored) or carries a custom one. Text is capped at 5 MB per
-- scope in the console route; the dispatch-path reader is revision-keyed
-- cached, so a mutation converges within the revision bump.
CREATE TABLE IF NOT EXISTS "tenant_system_prompts" (
  "tenant_id"     uuid PRIMARY KEY REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "global"        jsonb,
  "providers"     jsonb NOT NULL DEFAULT '{}',
  "models"        jsonb NOT NULL DEFAULT '{}',
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);
```

Bentuk nilai (disimpan sebagai jsonb object per key):

```ts
// Global: null = never configured; object = explicit (enabled false = off).
type PromptSetting = {
  enabled: boolean;          // master on/off untuk scope itu
  mode: "append" | "override";
  text: string;              // cap 5 MB
};
// providers: key = providerId
//   { followGlobal: true }                    → pakai Global apa adanya
//   { followGlobal: false, setting: PromptSetting } → custom
type ProviderEntry = { followGlobal: boolean; setting?: PromptSetting };
// models: key = "providerId::modelId", value = PromptSetting (selalu eksplisit;
// hanya berlaku bila provider-nya tidak menolak fitur)
```

### 4.2 `migrations/lite-sqlite3/0031_tenant_system_prompts.sql`

```sql
-- Mirror of the Postgres migration; see that file for rationale.
CREATE TABLE IF NOT EXISTS "tenant_system_prompts" (
  "tenant_id"   TEXT PRIMARY KEY REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "global"      TEXT,
  "providers"   TEXT NOT NULL DEFAULT '{}',
  "models"      TEXT NOT NULL DEFAULT '{}',
  "updated_at"  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

(jsonb → TEXT berisi JSON; driverlite mem-parse via drizzle `jsonb` mode string — sama seperti tabel settings.)

### 4.3 Kode

- **Schema drizzle**: tabel `tenantSystemPrompts` di `src/persistence/schema.ts`; tipe `PromptSetting`/`ProviderEntry` + konstanta `SYSTEM_PROMPT_TEXT_CAP = 5_000_000` dan `SYSTEM_PROMPT_BUDDY_PREFIX/SUFFIX` di `src/console/system-prompt/contracts.ts` (modul baru, Elysia-free → aman diimpor dashboard).
- **Store**: `src/persistence/system-prompt-store.ts` — get/upsert per tenant, bump settings revision (`settings-revision.ts`) agar reader revision-keyed konvergen instan.
- **Console API**: `src/console/system-prompt/routes.ts` — `GET /system-prompt`, `PUT /system-prompt` (scope `dashboard:write`); validasi: text ≤ 5 MB, `mode` enum, key model `^[a-z0-9-]+::[^\s:]+$`, providers map bounded (mis. ≤ 256 entry).
- **Dispatch read**: `applyTenantPreferences` membaca lewat `preferencesReaderFor` (cache revision-keyed yang sama dengan RTK/PonyTail).

---

## 5. Transform — `applyInjectSystemPrompt`

```ts
// src/transport/request/system-prompt-injection.ts (baru)
export function applyInjectSystemPrompt(
  request: CanonicalRequest,
  prompts: TenantSystemPromptsRow | undefined,
  route: { providerId: string; modelId: string; serviceKind: ServiceKind },
): CanonicalRequest
```

1. Skip bila `serviceKind !== "llm"`.
2. Resolusi:
   - model scope enabled → pakai itu;
   - else provider scope: `followGlobal` → global; else custom enabled → itu;
   - else global enabled → itu;
   - else → no-op.
3. `append`: `system: [...existing, { kind: "text", text }]` (idempotent).
4. `override`: `system: [{ kind: "text", text }]`.
5. Untuk provider Buddy: teks TIDAK masuk canonical `system` — diteruskan sebagai `extraSystemText` melalui dispatch context ke `applyBuddySystemPrompt` (satu-satunya jalur adapter). `override` pada Buddy = tetap append terbungkus (identity Buddy wajib utuh); UI menandai ini.
6. Non-fatal; dipanggil sebelum RTK/PonyTail.

Perubahan Buddy (satu-satunya di adapter):

```ts
// buddy-chat-shared.ts — signature (backward compatible)
applyBuddySystemPrompt(messages, systemPrompt, extraSystemText?: string)
// body: messages.push({ role: "system",
//   content: extraSystemText
//     ? `${systemPrompt}\n\n${BUDDY_PREFIX}${extraSystemText}${BUDDY_SUFFIX}`
//     : systemPrompt })
```

Call site (`codebuddy/provider.ts`, `workbuddy/provider.ts`, `buddy-media.ts`) meneruskan teks dari dispatch context.

---

## 6. UI wiring

Modal 3-scope yang sudah ada (`InjectSystemPromptPanel.tsx`):
- Ganti state session-local → hook `useSystemPrompt`/`useUpdateSystemPrompt` (API §4.3).
- Kartu provider: tambah toggle **Follow global / Custom**; saat Custom → tombol Setup aktif (mode Append/Override + textarea + import). Saat Follow global → tampil "Following global prompt".
- Kartu provider Buddy: badge kecil "Wrapped injection" (teks tenant selalu dibungkus marker gateway setelah prompt identity) — override tidak tersedia di Buddy, UI menjelaskan.
- Mode selector Append/Override per scope; cap 5 MB ditampilkan sebagai hint.
- Banner "UI preview — persistence pending" dihapus begitu backend live.

---

## 7. Rencana implementasi

| Fase | Isi | Risk |
|---|---|---|
| **F1 — Core + DB** | Migration 0031 (kedua dialect) + schema + store + `applyInjectSystemPrompt` (skip systemone) + route console + tests | Rendah — pola PonyTail |
| **F2 — UI** | Sambungkan panel/modal ke API; follow-global toggle; mode selector; hapus banner | Rendah |
| **F3 — Buddy wrapped append** | `extraSystemText` param + marker prefix/suffix + live test `11-128`/`11151` (fallback: fitur dimatikan per-provider via konstanta) | Sedang — butuh live validation |
| **F4 — Hardening** | Audit-log perubahan prompt, body-limit check, per-key opt-out bila perlu | Rendah |

**Yang sengaja TIDAK dilakukan:** mengubah prompt identity/billing provider, prepend teks tenant sebelum identity (merusak prefix cache + gating), injection ke `systemone`, override telanjang tanpa identity provider.

---

## 8. Ringkasan keputusan (dari review)

1. ✅ Buddy: append dengan **awalan + akhiran prompt kita** (`<cartethyia:system-prompt>…</cartethyia:system-prompt>`) setelah prompt identity — live test di F3.
2. ✅ Override: menanggalkan system caller saja; prompt native provider tetap hidup (keputusan implementer).
3. ✅ Tabel dedicated migration 0031, dengan toggle **follow global / custom** per provider.
4. ✅ Cap **5 MB** per scope.
