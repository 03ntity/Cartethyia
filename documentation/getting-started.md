# Getting started

This guide is the source of truth for installing, configuring, running, and
checking Cartethyia.

## 1. Requirements

All local installs require:

- Bun 1.4.0 or newer;
- a terminal;
- a writable data directory.

The database requirement depends on the selected mode:

| Mode | Required database infrastructure |
|---|---|
| **Lite** | None. Cartethyia runs embedded SQLite locally. |
| **Full** | A reachable PostgreSQL database configured with `DATABASE_URL`. |

Redis is optional in both modes. Set `REDIS_URL` when coordination must be
shared between processes or instances. If it is unset, Cartethyia uses the
in-memory coordination backend.

## 2. Choose a database mode

Same features either way. Only the database changes.

| | Lite | Full |
|---|---|---|
| Database | Embedded SQLite | External PostgreSQL |
| Best for | One person, one machine | VPS, several people, sustained load |
| Needs | Nothing | A reachable PostgreSQL |
| Ceiling | Single process, single writer | Multiple instances |

Lite is the default written by `bun setup` and shipped in `.env.example`, and it
stores its database at
`<CARTETHYIA_DATA_DIR>/cartethyia.sqlite`. When that is unset: `%APPDATA%\Cartethyia`
on Windows, `~/Library/Application Support/Cartethyia` on macOS,
`$XDG_DATA_HOME/Cartethyia` (or `~/.local/share/Cartethyia`) on Linux.

Full:

```dotenv
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://user:password@host:5432/cartethyia
```

Redis is optional in both. Set `REDIS_URL` only when coordination is shared
across processes. Lite is not a cut-down edition: move to Full later by
exporting a JSON backup and importing it. The config does not need rebuilding.

## 3. npm global package

```bash
npm install -g cartethyia
cartethyia setup
carte
```

`-g` (npm's alias for `--global`) is required. A local `npm install cartethyia`
installs the package but leaves `cartethyia` and `carte` in
`./node_modules/.bin/`, which is not on `PATH`, so neither command resolves.
For a local install run `npx cartethyia` instead. On Linux and macOS a global
install may need `sudo`; if it does, see
<https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally>.

Update and uninstall use the same flag:

```bash
npm update -g cartethyia    # update
npm uninstall -g cartethyia # uninstall
```

Updating prints a command instead of running one, because npm cannot replace
the package directory while a process is executing out of it — on Windows the
rename fails with `EBUSY`. Stop the gateway, run the printed command, then
start again.

Setup creates the encryption key, asks Lite or Full, checks the database, and
stores `.env` in the OS config directory (`%APPDATA%\Cartethyia` on Windows,
`~/Library/Application Support/Cartethyia` on macOS, `$XDG_CONFIG_HOME/Cartethyia`
on Linux). Override it with `CARTETHYIA_CONFIG_DIR`. Generated config and SQLite
data stay outside the npm package. Setup does not install PostgreSQL.

`carte` starts the gateway and opens an arrow-key menu: **Open Console**,
**Reset console password**, **Backup**, an update entry, **Hide to tray**, and
**Exit**. It needs no desktop environment, so it works over SSH and on a
headless box. The update entry is labelled **Check for updates** only when no
release has been fetched yet; otherwise it reads **Up to date (v)** or
**Update to v**. `carte --tray` starts a system-tray icon instead —
versions, **Open Console**, **Reset console password**, **Backup**, and
**Exit** — and needs a graphical session; the launcher then releases the
terminal once the gateway is ready.
`cartethyia start` stays in the foreground. Exit drains the gateway through its
authenticated loopback endpoint before stopping. This does not install a
login/startup service.

`cartethyia setup --non-interactive` never prompts and reads the persisted
config. Full mode must already have `CARTETHYIA_DB_MODE=full` and a reachable
`DATABASE_URL` there; values supplied only in the shell are not copied to disk.
## 4. Install dependencies

From the repository root, install both Bun workspaces (backend and dashboard):

```bash
bun install --linker isolated
```

The isolated linker creates dependency directories for both the repository
root and `dashboard/`; one command installs both workspaces. Do not run a
separate install from `dashboard/`. Installation does not create the database,
generate `.env`, or start Cartethyia.

## 5. Configure and validate the installation

Run the unified setup command:

```bash
bun setup
```

`bun setup` refuses Bun older than 1.4.0, creates `.env` from `.env.example`,
generates `CARTETHYIA_ENCRYPTION_KEY` when missing, asks Lite or Full, probes
ports 12800, 8080, 3000, and 8081 and asks which to use, prepares the Lite data
directory or asks for `DATABASE_URL` in Full, and checks Redis only when
`REDIS_URL` is set. It does not install PostgreSQL and it does not start the
gateway. After it, open the console and finish the first-boot wizard.

`CARTETHYIA_DB_MODE` has no default: the gateway throws at boot when it is
absent, because the two modes are different databases and a silent guess would
pick which one an install's data is read against.

```bash
bun setup --non-interactive   # never prompts; fails when Full config is missing
bun doctor                    # checks .env, the database, optional Redis, readiness
```
## 6. Configure encryption

`CARTETHYIA_ENCRYPTION_KEY` is a required 256-bit secret. It encrypts stored
provider credentials and API keys. Treat it like a password and keep it outside
version control.

The setup command generates it. Generate one yourself only when rotating:

```bash
openssl rand -hex 32
bun -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))"
```

A 64-character hex value or Base64 of 32 bytes are both accepted.

## 7. Start Cartethyia

Production builds first, then runs the compiled binary:

```bash
bun run build && bun run start
```

`bun run start` stops with "binary is missing" if you skip the build.
Development needs no build and hot-reloads: `bun run dev`. Split processes with
`bun run dev:backend` and `bun run dashboard:dev`, or `bun run dev:watch` to
restart on file changes.

Open `http://localhost:<PORT>/console`. Both forms listen on the same `PORT`
(12800 unless setup was told otherwise). The dashboard dev server on 5173
proxies to it and never needs to be opened on a VPS. When `PORT` changes,
`CARTETHYIA_PUBLIC_ORIGIN` must use it too, or OAuth callbacks miss.

| Endpoint | Purpose |
|---|---|
| `/health`, `/health/ready` | Liveness, and database/migration readiness |
| `/metrics` | Prometheus |
| `/v1/*` | Gateway API |
| `/console` | Dashboard |
| `/share/:token` | Public child-key enrollment |

## 8. Docker

Docker Compose defaults to Full mode and bundled Redis coordination:

```bash
docker compose up --build -d
docker compose logs -f app
```

Stop the stack with:

```bash
docker compose down
```

Full mode requires an external PostgreSQL reachable through `DATABASE_URL`; the
Compose file does not bundle PostgreSQL. Inside Compose, Redis uses the
Compose-only `CARTETHYIA_REDIS_URL`, because `environment` wins over `env_file`.
A host-oriented `REDIS_URL=redis://localhost:6379` in `.env` therefore cannot
leak into the container. To run the app container with Lite:

```dotenv
CARTETHYIA_DB_MODE=lite
# DATABASE_URL is not needed in Lite mode.
# CARTETHYIA_REDIS_URL=  # omit or leave empty for in-memory coordination
```

The Compose app stores gateway state and telemetry payloads in the persistent
`/app/data` volume. Redis starts as a helper container in either mode, but the
application uses the in-memory backend when `CARTETHYIA_REDIS_URL` is empty.

## 9. Migrations and backups

Numbered migrations under `migrations/full-postgres/` (Full) and
`migrations/lite-sqlite3/` (Lite) run automatically at boot and are
recorded in `cartethyia_schema_migrations`.

To move an installation from Lite to Full:

1. open the Lite dashboard;
2. export a backup from **Settings → Backup**;
3. configure and start the Full instance with an empty or new database;
4. wait for `/health/ready` to return HTTP `200`;
5. import the backup in the Full dashboard.

Backups may contain provider credentials and API-key data. Treat them like
passwords and store them securely.

## 10. Test database

Database-backed tests use the disposable URL in `CARTETHYIA_TEST_DATABASE_URL`,
not the runtime `DATABASE_URL`. Keep optional test service settings in the
existing local `.env` (created from `.env.example`) or export them in your
shell; there is no separate test env file. The backend suite requires
`CARTETHYIA_TEST_DATABASE_URL`; dashboard tests do not need a database.

Check the test database:

```bash
bun run test-db:check
```

If local PostgreSQL is unavailable, use the disposable test database in Compose
and add its URL to your existing `.env`:

```bash
bun run test-db:up
```

```dotenv
CARTETHYIA_TEST_DATABASE_URL=postgres://cartethyia_test:cartethyia_test@127.0.0.1:55432/cartethyia_test
```

Then run:

```bash
bun run test-db:check
bun run test:backend
bun run test-db:down
```

Never use production data for tests.

## 11. Verification commands

Run the gates relevant to the change:

```bash
bun run typecheck
bun run dashboard:typecheck
bun run dashboard:build
bun run test:backend
bun run dashboard:test
bun run build
```

Typechecking is not runtime proof. For behavior changes, also exercise the real
boundary: a gateway request, a browser surface, a provider flow, or an isolated
database migration.

### Do not run `bun test` directly

`bun test` is defined, but it is not the gate — it skips the runner, and the
runner is what makes the TLS-dependent suites pass. `scripts/ci/run.ts` merges
`test/fixtures/localhost-cert.pem` into a bundle and passes it to the subprocess
as `NODE_EXTRA_CA_CERTS`. Bun reads that variable only at process start, so a
direct `bun test` has no extra CA and the outbound HTTP/2 suites fail on the
handshake. Use `bun run test`, or `bun run test:backend` / `bun run
dashboard:test` for one scope.

## 12. Server install (VPS, systemd, reverse proxy)

Everything above covers a local install. This section is the server path.

> [!WARNING]
> Cartethyia holds provider credentials and API keys on the machine you run it
> on. Restrict who can reach the console, and keep backups somewhere you control.

### 12.1 VPS — Lite (native, no Docker)

Verified on Debian 13, 1 vCPU / 2 GB, Bun 1.4.2.

```bash
# 1. Dependencies
apt-get update && apt-get install -y git curl unzip ca-certificates openssl

# 2. Bun
curl -fsSL https://bun.sh/install | bash
export PATH="/root/.bun/bin:$PATH"

# 3. Source
mkdir -p /opt/cartethyia/data
cd /opt/cartethyia
git clone -b dev https://github.com/risunCode/Cartethyia.git repo
cd repo

# 4. Configure
cp .env.example .env
cat >> .env <<EOF
CARTETHYIA_DB_MODE=lite
NODE_ENV=production
LOG_LEVEL=warn
PORT=8080
CARTETHYIA_ENCRYPTION_KEY=$(openssl rand -hex 32)
CARTETHYIA_PUBLIC_ORIGIN=https://your.domain
CARTETHYIA_DATA_DIR=/opt/cartethyia/data
CARTETHYIA_TELEMETRY_PAYLOAD_DIR=/opt/cartethyia/data/telemetry-payloads
CARTETHYIA_INSTALL_ID_DIR=/opt/cartethyia/data/.cartethyia
EOF

# 5. Build
bun install --linker isolated
bun run build
```

### 12.2 systemd

`/etc/systemd/system/cartethyia.service`, then `systemctl enable --now cartethyia`:

```ini
[Service]
Type=simple
WorkingDirectory=/opt/cartethyia/repo
EnvironmentFile=/opt/cartethyia/repo/.env
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/cartethyia/repo/dist/cartethyia
Restart=always
RestartSec=5
```

Check it with `curl http://127.0.0.1:8080/health/ready`.

### 12.3 Reverse proxy

Caddy: `your.domain { reverse_proxy 127.0.0.1:8080 }`.

Nginx must forward the client IP or every request looks like one IP:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
```

And set `TRUSTED_PROXY_CIDRS=127.0.0.1/32,10.0.0.0/8` in `.env`.

### 12.4 Auto-deploy

Use `scripts/install/lite.sh` rather than writing your own (see below). If you
do poll for updates, a build takes 3–5 minutes on 1 vCPU, so a 1-minute cron
stacks builds until the box runs out of memory. Poll every 5 minutes, take a
`flock` before fetching, and roll back to the previous commit if
`/health/ready` never comes up after the restart.

### 12.5 Port

`PORT` is the one public port; the default is 12800. A VPS whose NAT does not
forward it should set `PORT` to a forwarded port and set
`CARTETHYIA_PUBLIC_ORIGIN` to the same port, or OAuth callbacks miss. The
dashboard dev server on 5173 is local only. The app binds `0.0.0.0`; Docker
maps `${PORT:-12800}` to the container's 12800, so changing `PORT` changes the
host side only.

### 12.6 VPS — Full (native)

Same as VPS Lite through step 5, then:

```dotenv
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://user:password@host:5432/cartethyia
REDIS_URL=redis://localhost:6379
```

Install PostgreSQL:

```bash
apt-get install -y postgresql
sudo -u postgres createdb cartethyia
```

`bun doctor` validates `.env`, backend reachability, optional Redis, and
readiness. Run it after any Full-mode change.

Multiple instances are supported in Full mode. Put them behind a load balancer
and keep `REDIS_URL` shared.

### 12.7 Docker — bundling PostgreSQL

Section 8 covers the default Compose stack, which is Full mode with bundled
Redis and an external PostgreSQL reached through `DATABASE_URL`. To bundle
PostgreSQL in Compose instead of pointing at an external one, add a
`docker-compose.override.yml` with a `postgres:16-alpine` service, a
`pg_isready` healthcheck, and `app.depends_on` waiting for it. Mount its data
on a named volume.

### 12.8 One-shot install script

`scripts/install/lite.sh` — one command, Lite mode, no manual steps.
Idempotent; safe to re-run.

```bash
curl -fsSL https://raw.githubusercontent.com/risunCode/Cartethyia/dev/scripts/install/lite.sh | bash
# or, from a checkout:
bash scripts/install/lite.sh
```

That script is the canonical one-shot installer: it installs system packages
and Bun, installs the `cartethyia` npm package globally, writes `.env`, and
starts the gateway. With `--topology regular` it also installs Caddy and a
`caddy.service` unit; it writes no unit for Cartethyia itself. An existing
`.env` is never overwritten.

It takes flags, not environment overrides: `--mode lite|full`,
`--topology regular|nat`, `--domain <fqdn>`, `--port <n>`,
`--non-interactive`, and `--skip <packages,bun,postgres,redis,node,npm,caddy,env,start>`.

**NEXT after install:** the console first-boot wizard has not run yet. Open
`$ORIGIN/console`, or seed it non-interactively:

```bash
curl -s http://127.0.0.1:$PORT/console/api/auth/first-boot
curl -s -X POST http://127.0.0.1:$PORT/console/api/auth/setup \
  -H 'content-type: application/json' \
  -d '{"password":"CHANGE-ME","username":"admin"}'
```
