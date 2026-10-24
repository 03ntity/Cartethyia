# Cartethyia documentation

Install and run it, then read how it is built. Procedure lives in `.skills/`,
not here; `AGENTS.md` routes you to the right skill.

## Install and run

| Page | Covers |
| --- | --- |
| [Getting started](getting-started.md) | Requirements, database mode, `bun setup`, encryption key, starting the stack, Docker, migrations, the test database, verification gates — and the server install (VPS, systemd, reverse proxy, one-shot script) |
| [Why Cartethyia](why-cartethyia.md) | The problem it was built for, how it differs from plain forwarders, the Bun + Elysia choice, and the reverse-engineering method for provider gates |

## How it is built — one page per layer

| Page | Covers |
| --- | --- |
| [Architecture](reference/architecture.md) | Process, request path, routing snapshot and its invalidation, data, what is intentionally absent |
| [Providers](reference/providers.md) | Provider layers, boot and bundled vs BYOK, credentials and auth, discovery, quota, per-family notes |
| [Model name forms](reference/model-name-forms.md) | Every spelling a model name takes and where each is resolved |
| [SQLite parity](reference/sqlite-parity.md) | Measured dialect differences between Lite and Full, and which ones are not defects |
| [Configuration](reference/configuration.md) | Every environment variable. **Generated** from `src/config/spec.ts` by `scripts/tools/generate-config.ts`; regenerate it, never edit it by hand |

## One page per feature

| Feature | What it does |
| --- | --- |
| [CLI model mapping](features/cli-model-mapping.md) | Reroute a CLI tool's native model slots (`opus`, …) to operator-chosen targets, per API key |
| [Share keys](features/share-keys.md) | Issue a public link that enrolls a child key under a parent's policy |
| [Network pools](features/network-pools.md) | Choose and meter the egress a request leaves through |
| [Routing aliases and combos](features/routing-aliases-combos.md) | Name a model something else, or fan a name out to several |
| [Usage floor](features/usage-floor.md) | Skip accounts whose remaining quota is at or below a provider threshold |
| [Buddy media generation](features/buddy-media-generation.md) | Generate images and submit/poll video tasks through Buddy providers |
| [Buddy CLI identity](features/buddy-cli-identity.md) | Present a Buddy provider as the official CLI client rather than the desktop app |
| [Cursor provider](features/cursor-provider.md) | Run Cursor's agent protocol across two client requests, and refuse anything the client did not declare |

## The split

The reference pages hold the **indexes** — route tables, snapshot mechanics, and
one summary per layer. They summarise one row and
link into `features/` for the narrative behind it. Do not grow them into feature
manuals; add a page under `features/` instead.

```text
documentation/
├── getting-started.md    installing and running it, local and on a server
├── why-cartethyia.md     the problem it was built for and how it differs
├── archive/              UNTRUSTED historical record — see below
├── assets/screenshots/   console screenshots the README showcases
├── reference/            how it is built, one page per layer
└── features/             one page per feature
```

## `archive/` is not for reading

[`archive/`](archive/README.md) holds point-in-time records that are no longer
tied to the code — investigations that were open when they were written, and a
source-line snapshot. **Do not read it to answer a question about current
behavior, and never cite it as evidence.** Every `file:line`, symbol, path, and
measurement in there was true when it was written and has not been kept in sync.

## Procedure is in `.skills/`

Each skill owns one topic. `AGENTS.md` has the routing table.

| Skill | Topic |
| --- | --- |
| `cartethyia-engineering` | Cross-cutting rules: invariants, taste, gates, and the backend map |
| `cartethyia-trace-replay` | A failing request, wire and payload bytes, replaying against a remote instance |
| `cartethyia-health-routing` | Account and model health, cooldowns, pools, retries, leases |
| `cartethyia-provider-catalog` | Providers and models: add, remove, authenticate, capabilities, catalog |
| `cartethyia-console-api` | Authoring a console domain, and the console surface map |
| `cartethyia-dashboard` | Browser code, and the page map |
| `cartethyia-schema-telemetry` | Schema, migrations, and telemetry |
| `cartethyia-deployment` | Deploying to a server — regular VPS or NAT VPS |
| `cartethyia-reverse-engineering` | Reconstructing undocumented behavior from this repo's own code |

For the product overview, supported clients, and Cartethyia's main benefits, see
[`README.md`](../README.md).

For contribution rules and pull requests, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
