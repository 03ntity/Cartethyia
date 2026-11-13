/**
 * Probe phases 1–3 — resolve the wire target, the account, and the adapter.
 *
 * These phases decide *what* a probe runs as: which wire family/endpoint the
 * request dispatches to, which health-filtered account it uses, and which
 * adapter executes it. `probeModel` loads the provider snapshot once
 * (`loadProviderWireRow`) and reuses it across all three so a concurrent edit
 * cannot make two reads disagree.
 */
import { and, eq } from "drizzle-orm";
import { globalOrOwnedBy } from "../../persistence/tenant-scope";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { models, providerAccounts, providers } from "../../persistence/schema";
import type { ServiceKind, SourceSurface, WireFamily } from "../../protocol/canonical-model";
import type { CompatibilityProfile } from "../provider-metadata";
import type { ProbeModelRequest } from "./discovery-types";
import {
  constrainWireFamily,
  discoveryPathsFor,
  resolveDiscoveredWire,
  staticEndpointForWire,
  supportedWireFamiliesForProvider,
  type ProviderWireContext,
} from "./probe-wire";
import { OpenAICompatibleAdapter } from "../adapters/compatible-adapter";
import { resolveByokWireProfile } from "../operations/byok-wire-profile";
import { buildCapabilityProfile } from "../../transport/routing/route-catalog";
import { GatewayError } from "../../protocol/gateway-error";
import type { ModelDefinition } from "../provider-model-definition";
import type { ProviderAdapter, ProviderId } from "../provider-contracts";
import type { ProviderRegistry } from "../provider-registry";

/**
 * The provider row columns `loadProviderWireRow` selects, shared by the phases
 * so one row shape serves wire resolution, the account gate, and the
 * custom-adapter fallback.
 */
export interface ProbeProviderRow {
  readonly baseUrl: string | null;
  readonly wireFamilyDefault: WireFamily | null;
  readonly compatibilityProfile: unknown;
  readonly requiresAccount: boolean;
}

/**
 * Loads the provider row columns that decide wire-family/endpoint resolution.
 * `probeModel` and `discoverModels` each load this once and reuse it for the
 * contract gate, the custom-adapter fallback, and the wire context, so a
 * concurrent edit cannot make two reads disagree.
 */
export async function loadProviderWireRow(
  db: CartethyiaDatabase,
  providerId: string,
): Promise<ProbeProviderRow | undefined> {
  const rows = await db
    .select({
      baseUrl: providers.baseUrl,
      wireFamilyDefault: providers.wireFamilyDefault,
      compatibilityProfile: providers.compatibilityProfile,
      requiresAccount: providers.requiresAccount,
    })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  return rows[0];
}

/**
 * Maps a provider row onto the wire-resolution context. Nullable columns
 * normalize to `undefined` so the resolver's `??` layering applies.
 */
export function wireContextFrom(
  row: { wireFamilyDefault: WireFamily | null; compatibilityProfile: unknown } | undefined,
): ProviderWireContext {
  return {
    wireFamilyDefault: (row?.wireFamilyDefault as WireFamily | undefined) ?? undefined,
    endpointPathsByWireFamily: (row?.compatibilityProfile as CompatibilityProfile | null)
      ?.endpoint_paths_by_wire_family as Partial<Record<WireFamily, string>> | undefined,
    modelWireFamilies: (row?.compatibilityProfile as CompatibilityProfile | null)
      ?.model_wire_families as
      ReadonlyArray<{ pattern: string; wire_family: WireFamily }> | undefined,
  };
}

/** Resolved wire target for one probe: family, endpoint path, canonical surface. */
export interface ProbeTarget {
  readonly wireFamily: WireFamily;
  /**
   * Protocol shape of the probed row. A non-`llm` row (System One) is probed
   * through its native endpoint with a decision body, not the canonical chat
   * pipeline — the same split routing uses.
   */
  readonly serviceKind: ServiceKind;
  readonly endpointPath: string;
  readonly sourceSurface: SourceSurface;
  /**
   * The capability profile the probe dispatches under.
   *
   * A probe runs the real adapter, and a real adapter gates on capabilities
   * (`ClaudeAdapter` rejects every request whose required capabilities the
   * target does not declare). An empty profile therefore rejected the probe on
   * capabilities the route actually has — `prompt_caching`, `tools`,
   * `reasoning` — reporting a provider as broken over a gate the provider
   * passes for live traffic. Resolved from the same model row the router reads
   * so the probe tests the route, not an empty stand-in.
   */
  readonly capabilityProfile: Readonly<Record<string, boolean>>;
  /** The model row's output ceiling, when it declares one. */
  readonly outputLimit?: number | null;
}

/**
 * Phase 1 — resolve which wire family and endpoint path the probe dispatches
 * to. The provider's own contract decides which wires are reachable at all (the
 * adapter rejects anything else with `capability_unsupported`), so a stored
 * row, a bundled catalog row, or a discovery guess naming an unserved family
 * can only produce a 400; the resolved family is constrained to the contract
 * and a corrected family recomputes its endpoint.
 */
export async function resolveProbeTarget(args: {
  readonly db: CartethyiaDatabase;
  readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly defaultEndpoints: Record<WireFamily, string>;
  readonly providerId: string;
  readonly modelId: string;
  readonly request: ProbeModelRequest;
  readonly providerWireRow: ProbeProviderRow | undefined;
}): Promise<ProbeTarget> {
  const { db, bundledModelCatalog, defaultEndpoints, providerId, modelId, request, providerWireRow } =
    args;
  const requestedServiceKind: ServiceKind = request.serviceKind ?? "llm";
  const declaredFamilies = supportedWireFamiliesForProvider(
    providerId,
    providerWireRow?.wireFamilyDefault,
    providerWireRow?.compatibilityProfile,
  );
  // Operator profile > the provider's own bundled catalog (cline serves chat
  // from `/chat/completions`; the generic `/v1/…` default would join into an
  // unreachable path and surface as upstream 404) > probe map > generic
  // default. A custom provider's operator-entered base may already carry
  // `/v1`, so the resolved path is stripped to avoid `/v1/v1/messages`.
  const endpointForFamily = (family: WireFamily): string => {
    const profile = providerWireRow?.compatibilityProfile as CompatibilityProfile | null;
    const ep =
      profile?.endpoint_paths_by_wire_family?.[family] ??
      staticEndpointForWire(bundledModelCatalog, providerId, family) ??
      discoveryPathsFor(providerId)?.[family];
    return ep ?? defaultEndpoints[family] ?? "/v1/chat/completions";
  };

  let wireFamily: WireFamily;
  let endpointPath: string;
  // A native-service row (System One) probes through its native endpoint, not a
  // chat wire. Read from the same row the wire came from; an explicit
  // `request.wireFamily` never carries it (the operator is naming a chat wire).
  let serviceKind: ServiceKind = requestedServiceKind;
  // Capability columns for the row the probe lands on. Resolved alongside the
  // wire so the profile describes the same row the probe dispatches to.
  let capabilitySource: { modalities: unknown; reasoning: boolean; toolCall: boolean; outputLimit: number | null } = {
    modalities: null,
    reasoning: false,
    toolCall: false,
    outputLimit: null,
  };
  if (request.wireFamily) {
    wireFamily = request.wireFamily as WireFamily;
    endpointPath = endpointForFamily(wireFamily);
  } else {
    const staticDef = bundledModelCatalog
      .get(providerId)
      ?.find(
        (def) =>
          def.modelId === modelId &&
          (def.serviceKind ?? "llm") === requestedServiceKind &&
          (!request.route || def.endpointPath === request.route),
      );
    if (staticDef) {
      wireFamily = staticDef.wireFamily;
      endpointPath = staticDef.endpointPath;
      serviceKind = staticDef.serviceKind ?? "llm";
      capabilitySource = {
        modalities: staticDef.modalities,
        reasoning: staticDef.reasoning,
        toolCall: staticDef.toolCall,
        outputLimit: staticDef.outputLimit ?? null,
      };
    } else {
      const existing = await db
        .select({
          wireFamily: models.wireFamily,
          serviceKind: models.serviceKind,
          endpointPath: models.endpointPath,
          modalities: models.modalities,
          reasoning: models.reasoning,
          toolCall: models.toolCall,
          outputLimit: models.outputLimit,
        })
        .from(models)
        .where(
          request.route
            ? and(
                eq(models.providerId, providerId),
                eq(models.modelId, modelId),
                eq(models.serviceKind, requestedServiceKind),
                eq(models.endpointPath, request.route),
              )
            : and(
                eq(models.providerId, providerId),
                eq(models.modelId, modelId),
                eq(models.serviceKind, requestedServiceKind),
              ),
        )
        .limit(1);
      if (existing[0]) {
        wireFamily = existing[0].wireFamily as WireFamily;
        endpointPath = existing[0].endpointPath;
        serviceKind = existing[0].serviceKind as ServiceKind;
        capabilitySource = {
          modalities: existing[0].modalities,
          reasoning: existing[0].reasoning,
          toolCall: existing[0].toolCall,
          outputLimit: existing[0].outputLimit ?? null,
        };
      } else {
        if (requestedServiceKind !== "llm") {
          throw new GatewayError(
            "model_not_found",
            404,
            `No ${requestedServiceKind} model ${modelId} is registered for provider ${providerId} (request {requestId}). Try another model — this one's off the menu 📚`,
          );
        }
        const ctx = wireContextFrom(providerWireRow);
        const resolved = resolveDiscoveredWire(
          modelId,
          ctx,
          discoveryPathsFor(providerId),
          defaultEndpoints,
        );
        wireFamily = resolved.wireFamily;
        endpointPath = resolved.endpointPath;
      }
    }
  }
  // A stored row, a bundled catalog row, or a discovery guess is a cache of the
  // derivation, not an authority: it can name a wire the provider's own
  // declaration does not list, and dispatch would then answer
  // `capability_unsupported` for a probe the operator never asked for. The
  // contract wins for those derived sources and the endpoint is recomputed for
  // the family it selected, so the probe reports the provider's real shape.
  //
  // An explicit `request.wireFamily` is deliberately exempt: that is the
  // operator naming the wire themselves, not a derivation to be corrected. The
  // wire selector exists to reach an upstream protocol this gateway carries no
  // bundled knowledge of, so silently swapping the choice would probe a
  // different wire than the one requested — the failure this exemption fixes.
  if (!request.wireFamily) {
    const contracted = constrainWireFamily(wireFamily, declaredFamilies);
    if (contracted.corrected) {
      wireFamily = contracted.wireFamily;
      endpointPath = endpointForFamily(wireFamily);
    }
  }
  // Wire family and source surface are not the same vocabulary, so this cannot
  // be a plain assignment: `gemini` names a wire (native generateContent) but
  // has no canonical request surface of its own, while `completion` is a
  // surface with no matching wire.
  // Probing a Gemini wire therefore has to name the surface whose codec builds
  // the request, rather than pretending the wire is a surface.
  const sourceSurface: SourceSurface = wireFamily === "gemini" ? "chat" : wireFamily;
  // Built from the row the probe resolves to, so the adapter's capability gate
  // sees the same profile live traffic would. `providerId` is part of the
  // profile because a bespoke-wire provider has no canonical codec and must not
  // inherit a codec's modality grants.
  const capabilityProfile = buildCapabilityProfile({
    modalities: capabilitySource.modalities,
    reasoning: capabilitySource.reasoning,
    toolCall: capabilitySource.toolCall,
    providerId,
  });
  return { wireFamily, serviceKind, endpointPath, sourceSurface, capabilityProfile, outputLimit: capabilitySource.outputLimit };
}

/** The account a probe selected, or the operator-facing reason it could not. */
export type ProbeAccountSelection =
  | { readonly ok: true; readonly accountId: string | undefined }
  | { readonly ok: false; readonly error: string };

/**
 * Selects the first usable account row: status ≠ disabled, cooldown elapsed
 * (unless `allowCoolingAccount`), preferring a tenant-owned account over a
 * shared global one. Shared by the discovery and probing paths so both
 * agree on which account a provider answers as.
 */
export function selectUsableAccount<T extends {
  readonly tenantId: string | null;
  readonly status: string;
  readonly cooldownUntil: Date | null;
}>(
  rows: readonly T[],
  allowCoolingAccount = false,
  now = Date.now(),
): T | undefined {
  return rows
    .filter(
      (row) =>
        row.status !== "disabled" &&
        (allowCoolingAccount || row.cooldownUntil === null || row.cooldownUntil.getTime() <= now),
    )
    .sort((left, right) => Number(right.tenantId !== null) - Number(left.tenantId !== null))[0];
}

/**
 * Phase 2 — pick the account the probe runs as. Snapshot-equivalent health
 * filtering: disabled accounts and live cooldowns never route, so probes must
 * not select them either. Tenant-owned accounts win over shared global ones.
 */
export async function selectProbeAccount(args: {
  readonly db: CartethyiaDatabase;
  readonly tenantId: string;
  readonly providerId: string;
  readonly requestedAccountId: string | undefined;
  readonly requiresAccount: boolean;
  /** Explicit Grok 407 feature tests may verify a cooling account to recover it. */
  readonly allowCoolingAccount?: boolean;
}): Promise<ProbeAccountSelection> {
  const {
    db,
    tenantId,
    providerId,
    requestedAccountId,
    requiresAccount,
    allowCoolingAccount = false,
  } = args;
  const accountRows = requiresAccount
    ? await db
        .select({
          id: providerAccounts.id,
          tenantId: providerAccounts.tenantId,
          credentialKind: providerAccounts.credentialKind,
          status: providerAccounts.status,
          cooldownUntil: providerAccounts.cooldownUntil,
        })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.providerId, providerId),
            globalOrOwnedBy(providerAccounts.tenantId, tenantId),
            ...(requestedAccountId ? [eq(providerAccounts.id, requestedAccountId)] : []),
          ),
        )
    : [];
  const usableAccount = selectUsableAccount(accountRows, allowCoolingAccount);
  const accountId = requestedAccountId ?? usableAccount?.id;
  if (!accountId && requiresAccount) {
    return {
      ok: false,
      error:
        accountRows.length > 0
          ? "All configured accounts for this provider are disabled or cooling down."
          : "No account configured for this provider yet — add one before probing a model.",
    };
  }
  return { ok: true, accountId };
}

/**
 * Phase 3 — resolve the adapter that dispatches the probe. Custom/BYOK
 * providers (e.g. infercrot) have no bundled adapter but carry a baseUrl; fall
 * back to the generic OpenAI-compatible adapter so probe/dispatch still works.
 * The low-level compatible adapter is used directly to avoid importing concrete
 * integrations from discovery (which would violate the provider-architecture
 * layering test). `resolve(..., { force: true })` rebuilds the bundled adapter
 * against the current registration; `undefined` means "no bundled adapter"; a
 * throw is a registry failure and propagates rather than being reported as
 * "no adapter registered".
 */
export async function resolveProbeAdapter(args: {
  readonly providerRegistry: ProviderRegistry;
  readonly providerId: string;
  readonly providerWireRow: ProbeProviderRow | undefined;
}): Promise<ProviderAdapter | undefined> {
  const { providerRegistry, providerId, providerWireRow } = args;
  let adapter = await providerRegistry.resolve(providerId, { force: true });
  if (!adapter) {
    try {
      if (providerWireRow?.baseUrl) {
        const wireProfile = resolveByokWireProfile(
          providerWireRow.wireFamilyDefault,
          providerWireRow.compatibilityProfile as CompatibilityProfile | null,
        );
        adapter = new OpenAICompatibleAdapter({
          provider_id: providerId as ProviderId,
          base_url: providerWireRow.baseUrl,
          authentication_header_shape: wireProfile.authHeaderShape,
          endpoint_paths_by_wire_family: wireProfile.endpointPathsByWireFamily,
        });
      }
    } catch {
      // Custom adapter resolution failures safely fall through to unconfigured provider response.
    }
  }
  return adapter;
}
