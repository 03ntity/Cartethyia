# Installation

`scripts/install.sh` is the one-command installer for local Linux/macOS, VPS,
and Docker. It checks dependencies, configures the selected mode, builds or
starts the application, and runs the doctor automatically.

Local/source and VPS builds use **Bun only**. The installer does not install
Node.js or npm. The npm distribution and downloadable compiled artifacts are
separate delivery options; their requirements are not combined with a local
Bun install.

> [!WARNING]
> Cartethyia stores provider credentials and API keys on the host. Restrict
> console access, keep `.env` private, and store backups somewhere you control.

## Commands

From a checkout:

```bash
# Local Linux or macOS, embedded SQLite
bash scripts/install.sh --local --lite

# Local with PostgreSQL (uses an existing DATABASE_URL or provisions local DB)
bash scripts/install.sh --local --full

# Regular VPS: compiled gateway, systemd, Caddy and public TLS
bash scripts/install.sh --vps --regular --lite --domain app.example.com
bash scripts/install.sh --vps --regular --full --domain app.example.com

# NAT VPS: provider owns forwarding/TLS; no Caddy is installed
bash scripts/install.sh --vps --nat --lite --port 8080 --public-origin https://app.example.com:8080
bash scripts/install.sh --vps --nat --full --port 8080 --public-origin https://app.example.com:8080

# Existing checkout with Docker Engine and Compose
bash scripts/install.sh --docker --lite
bash scripts/install.sh --docker --full   # requires external DATABASE_URL
```

For a fresh local/VPS host, the same script can fetch the source checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/risunCode/Cartethyia/dev/scripts/install.sh \
  | bash -s -- --vps --regular --full --domain app.example.com
```

Fresh bootstrap needs Git, curl, and Python 3 for manifest parsing. Python is
not an application runtime. The installer finds/installs Bun from the version
requirement in `package.json`; it never installs Node as a second runtime.
Docker requires a full checkout and is not supported through curl-without-checkout.

## Target requirements

| Target | Required | Not installed automatically |
| --- | --- | --- |
| Local Lite | Linux/macOS, supported package manager, Bun via bootstrap | Node/npm, PostgreSQL, Redis, Caddy, Docker |
| Local Full | Local Lite requirements plus existing or installer-provisioned PostgreSQL | Node/npm; Redis unless requested |
| Regular VPS | Debian/Ubuntu Linux, root or noninteractive sudo, systemd, DNS pointing to the VM | Node/npm; Caddy only with `--no-caddy` |
| NAT VPS | Debian/Ubuntu Linux, systemd, explicitly forwarded port and public origin | Caddy, Node/npm |
| Docker Lite | Full checkout, Docker Engine and Compose | Host Bun/Node/PostgreSQL/Caddy |
| Docker Full | Docker Lite requirements plus reachable external `DATABASE_URL` | Bundled PostgreSQL, host Caddy |

Redis is optional in every mode. `--provision-redis` explicitly installs and
configures local Redis for local/VPS. An existing `REDIS_URL` is preserved and
checked. Unset Redis uses in-memory coordination; there is no `REDIS_MODE`
setting. Docker Compose uses its own `CARTETHYIA_REDIS_URL` behavior.

## Lifecycle and management

Local installation builds the compiled gateway, starts it detached, waits for
readiness, and returns to the shell. From the installation root:

```bash
./carte menu     # attach to the running gateway
./carte doctor   # configuration + readiness
./carte stop     # stop only this installation's gateway
```

A menu reattaches without restarting a healthy detached instance. Leaving an
attached menu does not stop it; use the explicit stop command. The gateway uses
the install's persistent drain token and PID/port ownership marker, never
`pkill`, `nohup`, or a port-wide process kill.

VPS uses `/etc/systemd/system/cartethyia.service` and the compiled
`dist/cartethyia`. Regular VPS manages Caddy only when DNS resolves to the
host. NAT leaves forwarding and TLS to the provider; readiness inside the VM
does not prove public reachability. Docker delegates lifecycle to Compose.

Open `$CARTETHYIA_PUBLIC_ORIGIN/console` after installation and complete the
first-boot wizard. Health/readiness does not enroll providers or prove upstream
connectivity.

## Operator flags

- `--check`: read-only dependency/config report; no installation or writes.
- `--dry-run`: print the ordered plan without mutation.
- `--no-start`: configure/build/install services but skip application start.
- `--skip-deps`: skip dependency installation, not validation.
- `--no-caddy`: Regular VPS behind an existing proxy; requires `--public-origin`.
- `--provision-redis`: install/start local Redis and write its URL.
- `--non-interactive`: no prompts; required flags must be explicit.
- `--root <path>`, `--port <n>`, `--domain <fqdn>`, `--public-origin <url>`.

Fresh bootstrap also accepts `CARTETHYIA_REPO_URL`, `CARTETHYIA_BRANCH`
(default `dev`), and `CARTETHYIA_ROOT`. Dirty developer checkouts are not
reset or pulled automatically. Existing installation roots are updated only by
fast-forward; conflicting non-git directories and live install locks fail.

## Reruns and changing modes

Reruns preserve custom env entries, existing valid encryption keys, database
URLs, and data. Config writes are atomic and use mode `0600` where supported.
The installer never rotates a key, resets an unknown PostgreSQL password,
removes a database/volume, or silently switches Lite to Full (or back).

Changing modes requires a JSON backup export, installation against a new
backend, readiness, then import. It is not an in-place database migration.

## Other delivery paths

The npm global package remains available as `npm install -g cartethyia`, with
`cartethyia setup` and `carte`. Its current launcher starts the Bun CLI, so do
not describe it as Node-only. Downloadable compiled releases bundle their Bun
runtime but still need companion dashboard/migration assets and writable state.
These channels are alternatives to the Bun local installer, not extra local
prerequisites.

See [getting started](getting-started.md) for application configuration,
backups, migrations, and verification.
