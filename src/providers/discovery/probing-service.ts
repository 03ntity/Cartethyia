/**
 * Provider probing and model-discovery orchestration.
 *
 * Network probes and `/v1/models` discovery stay separate from the Drizzle
 * catalog repository while sharing the provider catalog contract. The service
 * is now a thin facade: probe execution/batching lives in `ProbeRunner`
 * (`probe-runner.ts`), discovery + roster persistence in `ProbeDiscovery`
 * (`discovery-roster.ts`), and the constructor dependency contract is
 * unchanged.
 */
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { WireFamily } from "../../protocol/canonical-model";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { TelemetryPayloadCapture } from "../../observability/payload-capture";
import type { ModelDefinition } from "../provider-model-definition";
import type { ProviderRegistry } from "../provider-registry";
import type {
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  ProbeAllAccountsResult,
  ProbeAllModelsResult,
  ProbeModelRequest,
  ProbeModelResult,
} from "./discovery-types";
import { staticEndpointForWire } from "./probe-wire";
import type { ProbeEngineDeps } from "./probe-deps";
import {
  ProbeRunner,
  type ProbeOutboundBinding,
  type ProbeOutboundResolver,
} from "./probe-runner";
import { ProbeDiscovery } from "./discovery-roster";
import type { ProbeProviderRow } from "./probe-phases";

interface ProviderProbingDeps {
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  readonly defaultEndpoints: Record<WireFamily, string>;
  readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly outboundFetchFor: ProbeOutboundResolver;
  readonly snapshotInvalidator: { invalidate(): unknown };
  readonly providerRegistry: ProviderRegistry;
}

export { type ProbeOutboundBinding, type ProbeOutboundResolver };
export class ProviderProbingService {
  private readonly db: CartethyiaDatabase;
  private readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  private readonly payloadCapture: TelemetryPayloadCapture;
  private readonly defaultEndpoints: Record<WireFamily, string>;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly outboundFetchFor: ProbeOutboundResolver;
  private readonly snapshotInvalidator: { invalidate(): unknown };
  private readonly providerRegistry: ProviderRegistry;
  private readonly runner: ProbeRunner;
  private readonly discovery: ProbeDiscovery;

  constructor(deps: ProviderProbingDeps) {
    this.db = deps.db;
    this.telemetryBuffer = deps.telemetryBuffer;
    this.payloadCapture = new TelemetryPayloadCapture(this.db);
    this.defaultEndpoints = deps.defaultEndpoints;
    this.bundledModelCatalog = deps.bundledModelCatalog;
    this.outboundFetchFor = deps.outboundFetchFor;
    this.snapshotInvalidator = deps.snapshotInvalidator;
    this.providerRegistry = deps.providerRegistry;
    this.runner = new ProbeRunner(this.buildDeps(), this.payloadCapture);
    this.discovery = new ProbeDiscovery(this.buildDeps());
  }

  private buildDeps(): ProbeEngineDeps {
    return {
      db: this.db,
      telemetryBuffer: this.telemetryBuffer,
      defaultEndpoints: this.defaultEndpoints,
      bundledModelCatalog: this.bundledModelCatalog,
      outboundFetchFor: this.outboundFetchFor,
      snapshotInvalidator: this.snapshotInvalidator,
      providerRegistry: this.providerRegistry,
    };
  }

  /**
   * Static endpoint for one provider + wire family, if the bundled catalog
   * ships a static definition for it. Used by manual registration (via the
   * console store) so it resolves the same provider-truth endpoints as probes.
   */
  async resolveStaticEndpoint(
    providerId: string,
    wireFamily: WireFamily,
  ): Promise<string | undefined> {
    return staticEndpointForWire(this.bundledModelCatalog, providerId, wireFamily);
  }

  /** One-shot connectivity test. See `ProbeRunner.probeModel`. */
  async probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult> {
    return this.runner.probeModel(tenantId, providerId, request);
  }

  /** Ad-hoc connectivity test for a not-yet-persisted BYOK provider. */
  async testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult> {
    return this.runner.testByokConnection(tenantId, request);
  }

  /**
   * Batched provider-wide probe. `probeModel` is passed through so a subclass
   * override stays the single dispatch point.
   */
  async probeAllModels(
    tenantId: string,
    providerId: string,
    requests: readonly ProbeModelRequest[],
  ): Promise<ProbeAllModelsResult> {
    return this.runner.probeAllModels(providerId, requests, (request) =>
      this.probeModel(tenantId, providerId, request),
    );
  }

  /**
   * Batched account-wide probe. `probeModel` is passed through so a subclass
   * override stays the single dispatch point.
   */
  async probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeAllAccountsResult> {
    return this.runner.probeAllAccounts(tenantId, providerId, request, (probeRequest) =>
      this.probeModel(tenantId, providerId, probeRequest),
    );
  }

  /** Read-only model listing fetch. See `ProbeDiscovery.discoverModels`. */
  async discoverModels(
    tenantId: string,
    providerId: string,
  ): Promise<{
    readonly supported: boolean;
    readonly models: readonly ModelDefinition[];
    readonly accountLabel?: string;
    readonly wire: {
      readonly providerRow: ProbeProviderRow | undefined;
      readonly supportedWireFamilies: readonly WireFamily[] | undefined;
      readonly baseUrl: string | undefined;
    };
  }> {
    return this.discovery.discoverModels(tenantId, providerId);
  }

  /** Full roster sync. See `ProbeDiscovery.syncModels`. */
  async syncModels(tenantId: string, providerId: string): Promise<{ synced: number }> {
    return this.discovery.syncModels(tenantId, providerId);
  }

  /** Operator-selected roster commit. See `ProbeDiscovery.commitDiscoveredModels`. */
  async commitDiscoveredModels(
    tenantId: string,
    providerId: string,
    selectedIds: readonly string[],
  ): Promise<{ synced: number }> {
    return this.discovery.commitDiscoveredModels(tenantId, providerId, selectedIds);
  }
}
