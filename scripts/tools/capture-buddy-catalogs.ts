/**
 * Captures live Buddy-family model catalogs into `data/provider-catalogs/`.
 *
 * This replaces the ad-hoc script that produced
 * `buddy-live-model-catalogs-2026-10-12.json`; that run was not committed, so
 * the file could not be regenerated. It now can be.
 *
 * The capture is deliberately read-only and ephemeral: it calls the same
 * `GET /v3/config` the provider discovery path calls, records the roster, and
 * writes NOTHING that identifies the account. Credentials are read from a
 * file passed on the command line and never echoed.
 *
 * Usage:
 *   bun run scripts/tools/capture-buddy-catalogs.ts \
 *     --creds C:\path\to\cb-accounts-<timestamp>.json \
 *     [--out data/provider-catalogs/buddy-live-model-catalogs-<date>.json]
 *
 * `--check` exits nonzero when a live roster differs from the stored one, which
 * is the useful form for CI or a scheduled refresh check.
 */

import { parseArgs } from "node:util";

interface RawModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly disabled?: unknown;
  readonly maxInputTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly supportsImages?: unknown;
  readonly supportsToolCall?: unknown;
  readonly supportsReasoning?: unknown;
  readonly credits?: unknown;
  readonly tags?: unknown;
}

interface CatalogModel {
  id: string;
  name: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  supportsImages: boolean;
  supportsToolCall: boolean;
  supportsReasoning: boolean | null;
  credits: string;
}

interface Catalog {
  providerId: string;
  host: string;
  endpoint: string;
  identityUserAgent: string;
  httpStatus: number;
  envelopeCode: number | null;
  cliModelIds: readonly string[];
  models: readonly CatalogModel[];
}

const IDENTITY_USER_AGENT =
  "CLI/4.12.1.39217423 CodeBuddy/4.12.1.39217423";

/** Hosts to probe, with the provider id their roster is stored under. */
const SITES: readonly { providerId: string; host: string }[] = [
  { providerId: "cb", host: "www.codebuddy.ai" },
  { providerId: "workbuddy", host: "www.workbuddy.ai" },
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `sub` of an access token, so the directory scores by account. Undefined for opaque keys. */
function accountUid(credential: string): string | undefined {
  const parts = credential.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

async function captureSite(
  providerId: string,
  host: string,
  credential: string,
): Promise<Catalog> {
  const uid = accountUid(credential);
  const response = await fetch(`https://${host}/v3/config`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential}`,
      "user-agent": IDENTITY_USER_AGENT,
      "x-product": "SaaS",
      ...(uid === undefined ? { "x-no-user-id": "1" } : { "x-user-id": uid }),
      "x-no-enterprise-id": "1",
      "x-no-department-info": "1",
    },
    signal: AbortSignal.timeout(20_000),
  });

  const empty: Catalog = {
    providerId,
    host,
    endpoint: "GET /v3/config",
    identityUserAgent: IDENTITY_USER_AGENT,
    httpStatus: response.status,
    envelopeCode: null,
    cliModelIds: [],
    models: [],
  };
  if (!response.ok) return empty;

  const envelope = asRecord(await response.json().catch(() => undefined));
  if (envelope === undefined) return empty;
  const code = envelope["code"];
  if (code !== 0) return { ...empty, envelopeCode: typeof code === "number" ? code : null };

  const data = asRecord(envelope["data"]);
  const rawModels = data?.["models"];
  if (!Array.isArray(rawModels)) return { ...empty, envelopeCode: 0 };

  // The CLI agent's roster, when published, is the callable subset — the same
  // rule the runtime discovery path applies, so the capture matches what a
  // sync would actually persist.
  const agents = data?.["agents"];
  let cliRoster: Set<string> | undefined;
  if (Array.isArray(agents)) {
    for (const entry of agents) {
      const agent = asRecord(entry);
      if (agent?.["name"] !== "cli") continue;
      const listed = agent["models"];
      if (Array.isArray(listed) && listed.length > 0) {
        cliRoster = new Set(listed.filter((id): id is string => typeof id === "string"));
      }
      break;
    }
  }

  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    const model = asRecord(entry) as RawModel | undefined;
    const id = model?.id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    if (model?.disabled === true) continue;
    const lowerId = id.toLowerCase();
    if (
      lowerId.startsWith("nes-") ||
      lowerId.startsWith("completion-") ||
      lowerId.startsWith("codewise-")
    ) {
      continue;
    }
    const output = asNumber(model?.maxOutputTokens);
    if (output !== null && output <= 256) continue;
    const tags = model?.tags;
    if (
      Array.isArray(tags) &&
      tags.some((tag) => typeof tag === "string" && tag.toLowerCase() === "text-to-image")
    ) {
      continue;
    }
    if (cliRoster !== undefined && !cliRoster.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: typeof model?.name === "string" && model.name.length > 0 ? model.name : id,
      maxInputTokens: asNumber(model?.maxInputTokens),
      maxOutputTokens: output,
      supportsImages: model?.supportsImages === true,
      supportsToolCall: model?.supportsToolCall === true,
      supportsReasoning: model?.supportsReasoning === true ? true : null,
      credits: asString(model?.credits),
    });
  }

  return {
    ...empty,
    envelopeCode: 0,
    cliModelIds: cliRoster === undefined ? [] : [...cliRoster],
    models,
  };
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    out: { type: "string" },
    check: { type: "string" },
  },
});

const credsPath = values.creds;
if (typeof credsPath !== "string") {
  console.error("--creds <path to exported accounts json> is required");
  process.exit(2);
}

const credsFile = await Bun.file(credsPath).json().catch(() => null) as
  | { accounts?: readonly { accessToken?: unknown }[] }
  | null;
const token = credsFile?.accounts?.[0]?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  console.error(`no accessToken found in ${credsPath}`);
  process.exit(2);
}

const catalogs: Catalog[] = [];
for (const site of SITES) {
  const captured = await captureSite(site.providerId, site.host, token);
  catalogs.push(captured);
  console.log(
    `[capture] ${site.host}: http=${captured.httpStatus} code=${captured.envelopeCode} ` +
      `models=${captured.models.length} cli=${captured.cliModelIds.length}`,
  );
}

const failed = catalogs.filter((c) => c.models.length === 0);
if (failed.length > 0) {
  console.error(
    `[capture] ${failed.map((c) => c.host).join(", ")} returned no models — ` +
      `refusing to overwrite a working catalog with an empty roster.`,
  );
  process.exit(1);
}

const capturedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const payload = {
  capturedAt,
  source:
    "Live GET /v3/config using temporary credentials; credentials and account identity are not included.",
  catalogs,
};

if (typeof values.check === "string") {
  const stored = (await Bun.file(values.check).json().catch(() => null)) as
    | { catalogs?: readonly Catalog[] }
    | null;
  const previous = new Map((stored?.catalogs ?? []).map((c) => [c.providerId, c]));
  let drift = 0;
  for (const current of catalogs) {
    const before = previous.get(current.providerId);
    const beforeIds = new Set((before?.models ?? []).map((m) => m.id));
    const nowIds = new Set(current.models.map((m) => m.id));
    const added = [...nowIds].filter((id) => !beforeIds.has(id));
    const removed = [...beforeIds].filter((id) => !nowIds.has(id));
    if (added.length > 0 || removed.length > 0) {
      drift++;
      console.log(
        `[check] ${current.providerId}: +${added.length} added (${added.join(", ") || "-"}) ` +
          `-${removed.length} removed (${removed.join(", ") || "-"})`,
      );
    } else {
      console.log(`[check] ${current.providerId}: unchanged (${nowIds.size} models)`);
    }
  }
  console.log(drift === 0 ? "[check] no drift" : `[check] drift in ${drift} catalog(s)`);
  process.exit(drift === 0 ? 0 : 1);
}

const outPath =
  typeof values.out === "string"
    ? values.out
    : `data/provider-catalogs/buddy-live-model-catalogs-${capturedAt.slice(0, 10)}.json`;
await Bun.write(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[capture] wrote ${outPath} (${catalogs.length} catalogs)`);
