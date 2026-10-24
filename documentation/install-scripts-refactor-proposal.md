# Proposal: Refactor Ringan `scripts/` dan Unified Installer

Status: **proposal untuk review — belum diimplementasikan**.

Tanggal audit: 2026-10-24.

## 1. Tujuan dan batasan

- Rapikan `scripts/`: relasi yang berdekatan, subfolder lebih sedikit, satu file punya tanggung jawab jelas.
- Jadikan installer satu source of truth untuk Local Lite/Full, VPS NAT/Regular, Docker, Linux, dan macOS.
- **User cukup menjalankan satu command dengan flag preset.** Install dependency, konfigurasi, Caddy/service bila diperlukan, start, dan doctor berjalan otomatis; bukan rangkaian command manual.
- **Local/source adalah Bun-first dan Bun-only.** Tidak ada proyek Node runtime adapter atau compatibility matrix baru untuk development. npm/Node distribution dan compiled online tetap menjadi delivery terpisah.
- **First-user optimization adalah behavior change yang disengaja.** Struktur/packaging boleh berubah; development/source bukan penentu utama UX instalasi.
- Satukan dependency preflight, runtime preflight, dan post-install/runtime diagnosis.
- Refactor tetap tipis: pertahankan public CLI, command `package.json`, kontrak runtime, dan batas build artifact.
- Fase audit ini hanya membaca source. Tidak ada installer, aplikasi, build, atau test yang dijalankan.

## 2. Ringkasan rekomendasi

1. **Jangan flatten seluruh `scripts/` menjadi satu folder.** Pertahankan grouping domain tingkat satu: `cli/`, `install/`, `build/`, `test/`, `dev/`, `tools/`.
2. **Jadikan orchestrator TypeScript/Bun sebagai source of truth instalasi.** `scripts/install.sh` adalah one-command entry point dan bootstrap; local/source memakai Bun. Installer tidak perlu membangun atau mengurus distribusi Node; itu tetap delivery online/npm tersendiri.
3. **Satu ownership health checks:** `scripts/health.ts` dipakai installer, `cartethyia doctor`, dan `bun run doctor`. Pisahkan phase preflight dan runtime agar hasilnya tidak ambigu.
4. **Jangan jadikan installer pengganti Compose.** Target Docker menyiapkan host/env lalu mendelegasikan build/run ke `Dockerfile` + Compose. Entrypoint tetap owner privilege dan volume container.
5. **Hapus tiga wrapper installer setelah alias tersedia.** `install/lite.sh`, `install/vps.sh`, dan `install/vps-full.sh` bukan implementasi terpisah; alias command lebih jelas daripada mempertahankan empat nama untuk satu implementasi.
6. **Flatten isi `scripts/cli/`, bukan gabungkan semua modulnya.** Lifecycle dan UI command sudah cukup besar; merge hanya helper kecil yang benar-benar satu concern.

## 3. Temuan current state

### 3.1 Installer saat ini

| File | Fungsi aktual |
| --- | --- |
| `scripts/install/install.sh` | Satu implementasi Bash untuk apt/Bun/Node/npm, PostgreSQL/Redis, env, Caddy, dan foreground-background start. |
| `scripts/install/lite.sh` | Satu baris: meneruskan `--mode lite`. |
| `scripts/install/vps.sh` | Satu baris: meneruskan seluruh argumen tanpa menetapkan target. |
| `scripts/install/vps-full.sh` | Satu baris: meneruskan `--mode full`. |
| `scripts/cli/command/setup.ts` | Wizard config local, pilihan Lite/Full dan port, cek PostgreSQL/Redis, opsional Docker Redis; tidak menginstall PostgreSQL atau menjalankan gateway. |
| `scripts/cli/command/doctor.ts` | Cek env, DB/data directory, Redis, dan readiness; juga memuat aksi reset lockout. |

Implikasi: **flow instalasi sudah mulai terpusat, tetapi belum selesai**. Setup local dan installer server masih mengimplementasikan konfigurasi/probe secara berbeda.

### 3.2 Gap perilaku dan dokumentasi

Ini harus diperbaiki dalam refactor, bukan sekadar dipindahkan:

- `install.sh` menulis ulang `/root/.config/Cartethyia/.env` ketika step `env` tidak di-skip. Itu dapat mengganti key/origin/config dan bertentangan dengan klaim “existing `.env` is never overwritten” di dokumentasi deployment.
- Start menggabungkan `pkill -f "cartethyia start"`, `nohup`, dan `sleep 6`; ini bukan lifecycle systemd yang idempotent dan dapat mengenai proses yang bukan milik instalasi target.
- Default domain saat ini `cartethyia.risun.web.id`; default interaktif sebaiknya tidak memilih domain orang lain.
- Deteksi NAT/Regular yang gagal dapat jatuh ke `nat`. Hasil detection yang tidak pasti harus **unknown → minta input/fail**, bukan dianggap NAT.
- Mode/topology, port, domain, dan argumen yang kekurangan value belum divalidasi ketat.
- Full provisioning mengabaikan error `CREATE ROLE`/`CREATE DATABASE`, sehingga “role/database sudah ada” tidak dapat dibedakan dari kegagalan nyata. Password existing role juga tidak boleh ditebak/direset diam-diam.
- Arsitektur Caddy dipetakan langsung dari `dpkg --print-architecture`; perlu mapping eksplisit dan package repository yang didukung, bukan unduhan tarball yang diasumsikan selalu cocok.
- Dokumentasi `getting-started.md` dan `installation.md` tidak konsisten tentang artifact npm vs source build, systemd, dan flag/env overrides.
- Referensi deployment menjanjikan `--nat`, `--regular`, `--lite`, `--full`, `--skip-tls`, clone/update, build AOT/binary, dan systemd. Implementasi saat ini memakai `--mode/--topology` dan global npm; dokumen tersebut tidak boleh dijadikan spesifikasi aktual tanpa rekonsiliasi.
- Installer sekarang hard-coded Debian/Ubuntu (`apt`, `systemctl`, `/root`). Belum ada install path macOS meskipun `bun setup` dan package CLI bersifat cross-platform.

### 3.3 Struktur non-installer

Struktur domain `dev/`, `operations/`, `ci/`, `generate/`, `qa/`, `binary/`, dan `perf/` sudah cukup berguna. Masalah utamanya terlalu banyak istilah untuk concern berdekatan dan empat tingkat di dalam `cli/`.

Caller penting yang harus ikut berubah saat rename:

- `package.json`: command build/test/setup/doctor/QA/probe/restart.
- Test yang mengimpor `scripts/cli/gateway/drain-token.ts` dan `scripts/qa/console-auth.ts`.
- Source `src/config/runtime.ts` dan komentar build yang menyebut AOT path.
- Generated headers/references untuk generator dan SQLite DDL.
- `src/console/remote-support/service.ts` mencari launcher di root `scripts/`; jangan pindahkan tanpa mengubah resolver dan packaging.

### 3.4 Runtime local saat ini: Bun dan Node memang sama-sama terbawa

Kebutuhan harus dibedakan berdasarkan delivery, bukan ditulis sebagai satu daftar “requirements” untuk semua user:

| Delivery saat ini | Yang benar-benar menjalankan aplikasi | Tooling tambahan |
| --- | --- | --- |
| npm global | Node menjalankan `scripts/cli/bin/*.cjs`, lalu launcher memanggil Bun untuk `scripts/cli/main.ts` | **Node.js/npm + Bun saat ini** |
| Source/development | Bun menjalankan TypeScript backend/dashboard | **Bun**; Node.js tidak diperlukan untuk `bun install`/dev/build command normal |
| Compiled gateway `dist/cartethyia` | Bun runtime sudah tertanam di executable | Tidak perlu Bun/Node/npm untuk gateway, tetapi companion files tetap diperlukan |
| Docker | Container membawa runtime aplikasi | Host hanya perlu Docker/Compose; host Bun/Node tidak diperlukan |

Compiled gateway sekarang **belum otomatis menjadi pengganti npm CLI**: `setup`, menu, tray, update, dan `doctor` masih berada di TypeScript CLI. `scripts/cli/gateway/spawn.ts` juga meluncurkan `src/main.ts` melalui Bun. Karena itu menghapus Node/Bun dari daftar dependency tanpa mengubah packaging akan menghasilkan klaim palsu.

Node-only **belum terbukti oleh current npm launcher** karena `.cjs` masih memanggil Bun; catat ini sebagai gap distribusi online yang harus diverifikasi/diperbaiki di kanal distribusinya. Namun refactor ini **tidak akan mem-port backend `bun:sqlite`, `Bun.serve`, `Bun.spawn`, AOT, atau API Bun lain ke Node**. Local/source tetap Bun-first agar development tidak menanggung dua runtime.

Companion artifact yang tetap harus dipertahankan: dashboard dist, migrations, remote-support launchers untuk fitur tersebut, serta config/data directory yang writable. **Compiled berarti tidak perlu runtime/toolchain eksternal, bukan berarti seluruh instalasi selalu tepat satu file tanpa asset.**

## 4. Struktur target

```text
scripts/
├── install.sh                 # Bash bootstrap only; no install policy
├── install.ps1                # Optional Windows parity; not a release blocker for Linux/macOS
├── health.ts                  # Check definitions + preflight/post-install/doctor API
├── install/
│   ├── install.ts             # Parse CLI, resolve target, execute ordered plan
│   ├── plan.ts                # Pure InstallRequest -> ordered steps; testable
│   ├── local.ts               # Local Linux/macOS Bun-first delivery
│   ├── vps.ts                 # Shared VPS provisioning + systemd + rollback
│   ├── docker.ts              # Compose preflight, config, build/up, verify
│   ├── config.ts              # Env merge/preserve secrets, config/data paths
│   ├── host.ts                # OS/package-manager/service primitives only
│   └── runtime.ts             # Bun/version/artifact checks; no Node adapter
├── cli/
│   ├── bin/                   # Existing npm launchers
│   ├── main.ts
│   ├── setup.ts               # Thin local-config wizard; calls health.ts
│   ├── doctor.ts              # Thin presentation/action command; calls health.ts
│   ├── start.ts
│   ├── console-menu.ts
│   ├── tray.ts
│   ├── admin.ts
│   ├── update.ts
│   ├── autostart.ts
│   ├── gateway.ts             # Merge spawn + stop
│   ├── instance.ts            # Merge instance lock + drain-token persistence
│   ├── env.ts
│   ├── platform.ts
│   ├── services.ts
│   ├── version.ts             # Merge bun requirement + package/registry version
│   ├── background.ts
│   ├── prompt.ts
│   ├── wordmark.ts
│   ├── startup-signal.ts
│   └── tray/                  # Keep assets + platform launchers together
├── build/
│   ├── build.ts               # Orchestrator dashboard -> AOT -> binary
│   ├── aot.ts
│   ├── compile.ts
│   ├── compile-cli.ts         # Optional compiled UX, not the mandatory default
│   ├── start.ts
│   └── restart.ts
├── test/
│   ├── run.ts
│   ├── check-migrations.ts
│   ├── check-db.ts            # Rename from ci/db-check.ts
│   ├── console-session.ts
│   ├── console-auth.ts
│   └── visual-baseline.ts
├── dev/
│   └── supervisor.ts
└── tools/
    ├── probe-egress.ts
    ├── probe-cursor.ts        # Rename only if worthwhile; optional in light phase
    ├── media.ts
    ├── generate-config.ts
    ├── generate-models.ts
    ├── generate-sqlite.ts
    ├── perf-start.ts
    ├── perf-upstream.ts
    ├── perf-seed.ts
    └── perf-load.ts
```

### Prinsip relasi dan merge

- **Merge nyata:** installer wrapper → alias satu orchestrator; `ci/` + `qa/` → `test/`; `operations/` + `generate/` + `perf/` → `tools/`; `binary/` → `build/`; `support/bun.ts` + `support/version.ts` → `cli/version.ts`; `gateway/spawn.ts` + `stop.ts` → `cli/gateway.ts`; lock/drain persistence → `cli/instance.ts`.
- **Jangan merge:** `build/aot.ts` dan `compile.ts` (transform vs compile berbeda); `dev/supervisor.ts` dengan binary restart (development proxy vs production lifecycle); generator satu sama lain (input/output berbeda); test runner dengan migration checker; `console-menu` dan `tray` (UI/session berbeda); semua perf harness menjadi satu file.
- **Retire candidate:** `dev/restart-carte.sh` adalah Windows/Git-Bash-specific hard kill pada port tetap. Hapus setelah `dev:watch`/supervisor dikonfirmasi menutup kebutuhan caller; jangan merge logic hard kill ke supervisor.
- **Remote support:** tetap di root pada refactor tipis. Relokasi ke `scripts/remote-support/` boleh dilakukan terpisah bersama `service.ts`, tests, dan npm `files`; jangan dipindah hanya untuk kosmetik.

Urutan rename harus dilakukan bersama semua import, package command, tests, docs, dan generated references dalam commit yang sama. Jangan sisakan shim TypeScript lama tanpa rencana penghapusan.

## 5. Kontrak unified installer

### 5.1 Source of truth yang dimaksud

`install/install.ts` + `plan.ts` adalah satu owner **urutan dan policy instalasi**, bukan satu file yang memonopoli semua detail:

- `host.ts`: fakta platform dan primitive package/service.
- `config.ts`: hasil konfigurasi dan aturan preservasi secret/data.
- `runtime.ts`: requirement Bun/npm/package delivery.
- `health.ts`: keputusan check dan severity.
- Target modules: perbedaan local, VPS, dan Docker saja.
- `Dockerfile`, Compose, dan entrypoint tetap source of truth container build/runtime.
- `package.json` tetap source of truth versi package dan minimum Bun (`engines.bun`).

Shell bootstrap tidak menduplikasi plan, konfigurasi, atau runtime checks. Ia memvalidasi OS/arch, menemukan atau menginstall **Bun saja**, lalu menjalankan orchestrator dari checkout/release source untuk target local/source. Versi minimum dibaca dari `package.json`, bukan disalin sebagai literal di shell/TypeScript.

Untuk fresh machine, `curl ... | bash -s -- <flag>` mengambil release source bila checkout belum ada. Setelah itu dependency install, setup, build bila diperlukan, start, dan doctor ditangani otomatis. User tidak perlu menjalankan command tersebut secara terpisah.

Distribution npm/Node dan compiled online tidak perlu dibuat ulang oleh local installer. Dokumentasi cukup menautkan command/artifact resminya sebagai alternatif; jangan mencampur dependensinya dengan checklist local Bun.

### 5.2 Command surface

Flag pendek adalah public UX. Dua sumbu tetap dipisahkan di internal request: **target** menjawab “di mana/bagaimana dijalankan”, **mode** menjawab “database apa”.

```bash
# Local Linux/macOS: install dependencies, configure, start, doctor.
bash scripts/install.sh --local --lite
bash scripts/install.sh --local --full

# VPS: systemd; Regular juga otomatis menyiapkan Caddy/TLS.
bash scripts/install.sh --vps --regular --lite --domain app.example.com
bash scripts/install.sh --vps --regular --full --domain app.example.com

# NAT: tidak memasang Caddy; origin/provider forwarding divalidasi.
bash scripts/install.sh --vps --nat --lite --port 8080 --public-origin https://app.example.com:8080
bash scripts/install.sh --vps --nat --full --port 8080 --public-origin https://app.example.com:8080

# Docker: dependency/daemon check, config, compose up --build, doctor.
bash scripts/install.sh --docker --lite
bash scripts/install.sh --docker --full
```

Fresh machine tetap one-liner, misalnya:

```bash
curl -fsSL <release-script-url> | bash -s -- --vps --regular --full --domain app.example.com
```

macOS dan Linux otomatis terdeteksi pada `--local`; tidak perlu flag OS. `--vps` tanpa `--regular/--nat` boleh mencoba deteksi, lalu bertanya jika interaktif atau fail jika hasilnya tidak pasti. Tanpa target, default interaktif adalah `--local`; non-interactive mewajibkan target eksplisit.

Local end-user dan developer sama-sama memakai Bun pada path ini; tidak ada flag `--from-source` yang memicu runtime lain. Node/npm tidak perlu diinstall oleh local installer.

`--check`, `--dry-run`, `--no-start`, `--skip-deps`, `--no-caddy`, dan `--provision-redis` hanyalah override untuk operator. Normal path tidak membutuhkannya. `cartethyia doctor` tetap tersedia untuk diagnosis berikutnya, tetapi **sudah otomatis dipanggil di akhir install**.

Rekomendasi: alias `cartethyia install --local --lite` hanya ditambahkan bila npm package memuat installer. Jangan menampilkan command yang tidak tersedia di artifact npm.

### 5.3 Preset/alias

Preset hanyalah kombinasi flag menuju plan yang sama, bukan script/code path berbeda:

| Flag | Target | Mode |
| --- | --- | --- |
| `--local --lite` | `local` | `lite` |
| `--local --full` | `local` | `full` |
| `--vps --regular/--nat --lite` | VPS topology | `lite` |
| `--vps --regular/--nat --full` | VPS topology | `full` |
| `--docker --lite/--full` | `docker` | explicit |

Kombinasi bertentangan seperti `--local --docker` atau `--lite --full` ditolak sebelum mutasi. Parser boleh menerima alias lama `--target/--mode`, tetapi dokumentasi utama hanya menampilkan UX flag pendek di atas.

### 5.4 Behavior matrix

| Concern | Local Linux/macOS | VPS Regular | VPS NAT | Docker |
| --- | --- | --- | --- | --- |
| Package delivery | Bun + release source/checkout; installer menjalankan build bila perlu | Compiled online atau Bun source build, satu policy yang konsisten | Sama dengan Regular | Dockerfile/Compose |
| Lite | Embedded SQLite, data dir writable | Sama + service sandbox | Sama + forwarded port | Named `/app/data` volume |
| Full | Otomatis install/start PostgreSQL pada package manager yang didukung, atau pakai `DATABASE_URL` existing | Otomatis provision local DB bila tidak ada `DATABASE_URL` | Sama | Check external `DATABASE_URL`; PostgreSQL tidak dibundel diam-diam |
| Redis | Optional; check only when configured | Optional; provision only with explicit flag | Sama | Existing Compose policy; empty/in-memory allowed |
| TLS/public origin | Local URL | Otomatis install/configure Caddy setelah public IP/DNS checks; `--no-caddy` untuk proxy existing | Provider owns TLS; never install Caddy | Tidak auto-install host Caddy; hanya lewat opsi proxy yang eksplisit |
| Lifecycle | Bun CLI yang ada (`setup/start/menu/doctor`) dengan background/start behavior yang dirapikan | systemd menjalankan selected production artifact | systemd menjalankan selected production artifact | Compose |
| Verification | Config + DB/Redis + optional app runtime | Service + readiness + local HTTPS/proxy check | Service + readiness; warn external forwarding unproven | Container health + readiness |

**Automatic bukan berarti destructive:** dependency yang hilang boleh diinstall otomatis setelah consent interaktif atau pada non-interactive plan yang didukung. Existing `DATABASE_URL`/service/config dipakai dan tidak di-reset. Redis tetap optional: hanya diinstall bila diminta/diperlukan konfigurasi. Docker Full tidak membuat PostgreSQL container baru secara diam-diam; gunakan `DATABASE_URL` existing atau berikan error/instruksi yang jelas.

Automatic dependency/Caddy provisioning hanya berlaku pada OS/package manager yang didukung. Selain itu installer berhenti sebelum mutasi dengan daftar paket/tindakan yang diperlukan, bukan berpura-pura semua platform sudah didukung.

### 5.5 Requirements yang ditampilkan ke user

| Penggunaan | Wajib | Tidak wajib |
| --- | --- | --- |
| **Local Lite, Bun** | Bun sesuai `engines.bun`, release source/checkout, config/data writable | Node.js/npm, PostgreSQL, Redis, Caddy, Docker |
| **Local Full, Bun** | Semua kebutuhan Lite + PostgreSQL reachable/local dan `DATABASE_URL` valid | Node.js/npm; Redis kecuali explicitly configured |
| **Development/build** | Sama dengan local Bun + workspace dependencies; dashboard/AOT/binary bila production build | Node.js/npm sebagai runtime kedua |
| **npm/Node distribution** | Delivery resmi dan requirement yang terbukti pada kanal tersebut; **bukan bagian local installer** | Tidak perlu checkout/build local; Node-only harus dibuktikan sebelum diklaim |
| **Compiled online** | Download executable + companion assets, config/data writable | Bun, Node.js, npm, build toolchain |
| **Docker** | Docker Engine + Compose plugin di host; Full memerlukan `DATABASE_URL` | Host Bun/Node/npm, host PostgreSQL untuk Lite, Caddy di dalam container |
| **VPS Regular** | Runtime artifact + systemd; Caddy bila installer memiliki TLS | Bun/Node pada prebuilt path; PostgreSQL untuk Lite |
| **VPS NAT** | Runtime artifact + systemd + forwarded port/public origin | Caddy, Bun/Node pada prebuilt path, PostgreSQL untuk Lite |

Redis bukan syarat Full maupun runtime dasar. Caddy hanya masuk checklist VPS Regular dengan TLS milik Cartethyia. Installer harus menampilkan **dependency untuk target yang dipilih saja**, bukan daftar gabungan semua mode.

Tidak ada pekerjaan membuat Node backend adapter atau mewajibkan compiled CLI baru pada local. Jika compiled CLI ditambahkan kemudian sebagai optimasi artifact online, ia tetap memakai AOT/TypeBox wiring yang sama, tidak memakai `bun run src/main.ts` sebagai child, dan menyelesaikan companion path tanpa bergantung pada source checkout/current working directory.

## 6. Dependency checker dan runtime checker

### 6.1 Satu model hasil

`health.ts` mengekspor pure check metadata dan probe adapters, misalnya:

```ts
type CheckPhase = "preflight" | "configuration" | "runtime";
type CheckStatus = "pass" | "warn" | "fail" | "skip";

interface CheckResult {
  id: string;
  phase: CheckPhase;
  status: CheckStatus;
  required: boolean;
  summary: string;
  remediation?: string;
}
```

Presentation human/JSON dan exit code memakai hasil yang sama. Probe menerima env/config eksplisit; jangan bergantung pada urutan import atau `process.exit()` di helper. Command tipis yang menentukan exit code.

### 6.2 Preflight — sebelum mutasi

- Platform dan architecture yang didukung; Linux vs macOS; Windows hanya bila PowerShell path memang diimplementasikan.
- Hak akses: user config vs root/systemd; jangan otomatis `sudo` tanpa persetujuan.
- Tool yang dibutuhkan target: Bun >= manifest, `curl`, `git`/npm sesuai delivery; `docker` + `docker compose` hanya target Docker.
- Package manager: apt/dnf/pacman/brew dideteksi eksplisit; fase awal boleh support apt + brew saja dan fail dengan pesan jelas pada lainnya.
- Ketersediaan port hanya sebagai **warning** bila gateway belum berjalan; jangan anggap port existing Cartethyia sebagai kegagalan reinstall.
- VPS Regular: ownership public IP hanya indikator, DNS domain, dan kelayakan port 80/443. NAT: forwarded port/origin wajib diberikan bila auto-detection tidak dapat membuktikannya.
- Full: format dan autentikasi PostgreSQL jika tersedia; Redis optional tetapi harus sehat bila explicitly configured.
- Docker: daemon/Compose, env file, volume, dan port host. Jangan jalankan `docker compose up` pada `--check`.

### 6.3 Configuration/post-install checks

- `.env` ada, `CARTETHYIA_DB_MODE` eksplisit, encryption key valid/bukan placeholder, origin/port konsisten.
- Lite: data/telemetry/install-ID directory writable oleh identity yang benar.
- Full: lakukan authenticated DB check (`SELECT 1`) bila driver/credential tersedia; TCP-only boleh disebut `warn`, bukan “database ready”.
- Configured Redis: gunakan ping bila memungkinkan; TCP-only dilabeli sesuai kemampuannya.
- Migrations/readiness dibuktikan oleh `/health/ready`, bukan oleh suksesnya package installation.

### 6.4 Runtime/doctor

`doctor` default memeriksa install existing secara **non-destruktif**. Readiness yang down dilaporkan sebagai status runtime, bukan otomatis “dependency rusak”. Opsi:

- `doctor --phase preflight`: dependency dan konfigurasi saja.
- `doctor --phase runtime`: termasuk `/health/ready`.
- Installer: preflight wajib sebelum perubahan, configuration setelah konfigurasi, runtime setelah start; `--no-start` menghasilkan `skip` untuk readiness, bukan fail.
- `doctor --reset-lockout` dipisah ke `cartethyia admin reset-lockout` pada fase cleanup. Sementara alias lama dipertahankan agar tidak breaking mendadak.

## 7. Flow dan idempotensi

```text
args -> validate InstallRequest -> resolve platform/target -> preflight
     -> dry-run/plan (optional) -> acquire install lock
     -> install missing OS/Bun/Docker dependencies -> acquire/update artifact
     -> provision required target services (Postgres/Caddy as applicable)
     -> merge config atomically -> install/build/start
     -> automatic doctor -> report URL + next steps + warnings
```

Aturan wajib:

- **Rerun tidak merotasi encryption key, mengganti DB password, menghapus database, atau menimpa config user.**
- Env ditulis atomik dengan mode `0600`; hanya key yang dimiliki installer yang diubah. Unknown/custom keys dipertahankan.
- Perubahan mode Lite ↔ Full bukan migrasi data. Rerun dengan mode berbeda harus fail dan menjelaskan backup/export-import; jangan diam-diam mengganti DB backend.
- Gunakan service manager dan identity/path instalasi, bukan `pkill -f` atau pola process global.
- Provision database harus transaksional/checkable. Existing role tanpa kredensial yang diketahui menghasilkan instruksi `DATABASE_URL`, bukan reset password.
- Install lock mencegah dua provisioning bersamaan. Build/service restart hanya setelah artifact berhasil.
- Health check gagal dilaporkan jujur. Rollback hanya untuk perubahan yang memang dapat dibatalkan; jangan klaim rollback database/destructive operations bila tidak ada.
- Default interactive meminta konfirmasi sebelum package/system changes. `--non-interactive` memerlukan semua input wajib; tidak ada domain/Password rahasia default.
- Semua secret tetap di host, tidak masuk stdout/JSON/report/git.
- `--dry-run` dan `--check` read-only; keduanya tidak menjalankan package install, write env, start service, atau Compose up.

## 8. Dokumentasi setelah implementasi

- `documentation/getting-started.md`: canonical requirements, local npm/source, mode, Docker, dan verification singkat.
- `documentation/installation.md`: canonical command matrix untuk semua target + server-specific detail.
- `.skills/cartethyia-deployment/references/install-script.md`: flags aktual dan behavior VPS saja.
- Reference NAT/Regular: hanya topology/TLS detail, bukan salinan alur installer.
- `.env.example`: konfigurasi aplikasi, **bukan** kedua source of truth install plan.

Hapus perintah/flag lama dari dokumentasi hanya setelah behavior pengganti benar-benar tersedia. Generated configuration docs tetap diregenerasi oleh owner generator, bukan diedit manual.

## 9. Tahapan implementasi

### Phase 0 — Protect behavior

- Tambah tests untuk resolver `InstallRequest`, dependency-check matrix, env merge, Lite/Full preservation, NAT unknown, dan exit code.
- Tambah contract tests untuk path package/CLI yang dipindah.
- Rekonsiliasi dokumentasi menjadi tiga delivery yang jelas: **local/source Bun**, **npm/Node online**, dan **compiled online**; VPS memilih artifact online atau Bun source build secara konsisten, bukan global npm + `nohup`.
- Verifikasi kanal npm/Node dan compiled online pada owner distribusinya. Jangan mem-port backend atau menambahkan runtime adapter untuk menyamakan development.

### Phase 1 — Rapikan struktur tanpa behavior change

- Flatten CLI dan rename `binary/` → `build/`.
- Konsolidasi `ci/` + `qa/` → `test/`; pindahkan `operations/`, `generate/`, `perf/` → `tools/` dengan nama yang jelas.
- Update imports, `package.json`, tests, docs, dan generated references.
- Tidak ada refactor functional pada phase ini; mudah di-review sebagai move-only + path updates.

### Phase 2 — Health/checker dan config owner

- Extract check/probe dari `setup.ts` dan `doctor.ts` ke `health.ts`.
- Hilangkan duplikasi Bun version; baca manifest dan pertahankan test semver.
- Extract env preservation/merge ke `install/config.ts` yang juga dapat dipakai setup.
- Pisahkan doctor reset-lockout dari health read path dengan alias kompatibel.

### Phase 3 — Unified install

- Implementasikan plan/orchestrator dan target local → VPS Regular → VPS NAT → Docker secara bertahap.
- Jadikan `install.sh` bootstrap tipis; hapus tiga wrapper setelah semua caller/docs beralih.
- Jangan mengklaim macOS selesai sebelum preflight/install/run benar-benar diverifikasi di macOS.
- Local installer menginstall/menemukan Bun, mengambil release source bila perlu, lalu menjalankan setup/start/doctor otomatis. Jangan menginstall Node/npm sebagai dependency local.

### Phase 4 — Verification dan dokumentasi

- Unit: argumen invalid, mode/target mismatch, plan per target, env merge, secret preservation, version comparison.
- Shell/static: `bash -n`, ShellCheck bila tersedia; PowerShell parser bila Windows path dibuat.
- Integration dengan disposable environment: fresh/re-run local Lite; Full dengan DB disposable; Docker Lite/Full; VPS systemd/Caddy/NAT lewat VM/container yang sesuai.
- Negative tests: Bun lama, tool hilang, DB salah password, Redis configured-down, port bentrok, DNS/public-IP mismatch, existing `.env`, service unhealthy.
- Existing gates: typecheck, backend/dashboard tests, build, Docker contract tests. Test menggunakan database khusus test, tidak pernah development/production.
- Dokumentasi diperbarui berdasarkan hasil aktual; tandai platform yang belum diuji secara eksplisit.

## 10. Acceptance criteria

- Satu command surface/plan menghasilkan semua target; dependency install, konfigurasi, service/Caddy, start, dan doctor berjalan otomatis tanpa logic yang terduplikasi di wrapper.
- Local Lite tidak meminta PostgreSQL; Full selalu memerlukan database valid; Redis optional dan tidak dipaksakan.
- VPS Regular hanya mengonfigurasi Caddy bila TLS memang dimiliki host; VPS NAT tidak menginstall Caddy atau workaround Regular.
- Docker tetap memakai Dockerfile/Compose/entrypoint dan persistent volume; tidak ada implementasi container kedua di installer.
- Linux dan macOS punya hasil preflight yang jelas; unsupported package manager gagal sebelum mutasi.
- Fresh local Lite hanya memerlukan Bun setelah bootstrap; setup/start/doctor berjalan tanpa Node/npm. Development tidak memerlukan Node compatibility layer.
- Alternatif npm/Node dan compiled online didokumentasikan terpisah; requirement keduanya tidak dicampur dengan local installer dan tidak diklaim melebihi verifikasi distribusinya.
- `--check`/`--dry-run` tidak bermutasi; preflight normal berjalan otomatis sebelum install dan rerun aman untuk config, secret, data, dan service.
- Doctor/setup/installer berbagi check definitions dan requirement Bun; tidak ada tiga versi dependency/runtime checker.
- Semua existing public commands bekerja atau memiliki alias dengan deprecation yang jelas; package artifact tetap memuat file yang dibutuhkan.
- Struktur akhir lebih datar tanpa mega-file; setiap merge punya alasan relasi yang nyata.

## 11. Keputusan untuk direview

Rekomendasi default gue, agar implementasi bisa langsung konsisten setelah proposal disetujui:

1. **Local/source Bun-first dan Bun-only. npm/Node serta compiled online adalah delivery alternatif yang tidak dikelola oleh local installer.** VPS memakai production artifact + systemd, bukan global npm + `nohup`.
2. **Full otomatis provision PostgreSQL** pada local/VPS dengan package manager yang didukung jika `DATABASE_URL` belum ada; Docker Full tetap memakai `DATABASE_URL` external. **Redis tetap opt-in**, bukan dependency wajib Full.
3. **Docker hanya host/bootstrap + Compose**, bukan install path aplikasi kedua.
4. **Fase pertama OS: Debian/Ubuntu + macOS Homebrew**; distro/package manager lain fail dengan pesan actionable, bukan fallback berbahaya.
5. **Alias installer lama dihapus setelah command baru dan docs sinkron**, bukan dipertahankan selamanya.

Tidak ada script yang diubah atau dijalankan untuk proposal ini. Satu-satunya artifact baru adalah dokumen ini.
