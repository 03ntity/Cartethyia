/**
 * Shared dependency contract for the discovery probing engines.
 *
 * Both `ProbeRunner` (probe execution/batching) and `ProbeDiscovery`
 * (discovery + roster persistence) are built from the same injected
 * dependencies the facade's constructor receives, so one shape serves all
 * three. The facade still takes the same object literal it always did — the
 * contract is unchanged, only the implementation has moved.
 */
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import type { WireFamily } from "../../protocol/canonical-model";
import type { ModelDefinition } from "../provider-model-definition";
import type { ProviderRegistry } from "../provider-registry";
import type { ProbeOutboundResolver } from "./probe-runner";

export interface ProbeEngineDeps {
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  readonly defaultEndpoints: Record<WireFamily, string>;
  readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly outboundFetchFor: ProbeOutboundResolver;
  readonly snapshotInvalidator: { invalidate(): unknown };
  readonly providerRegistry: ProviderRegistry;
}
