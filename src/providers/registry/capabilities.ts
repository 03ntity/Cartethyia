/**
 * Adapter, model, OAuth, and quota behavior keyed by canonical provider ID.
 *
 * Adapter and model references use dynamic `import()` so a provider's module
 * graph — including bespoke protobuf adapters and their large generated
 * declarations — is evaluated on first use rather than at startup. Model
 * catalogs are declared inline in flat API-key modules or complex
 * integrations, so a catalog load evaluates the same module the adapter uses;
 * the dynamic import still keeps that evaluation off the startup path.
 *
 * The rows live in the `capabilities-*.ts` group modules, split by provider
 * family; this module composes them in declaration order so the table's key
 * order stays stable.
 */
import { BUDDY_PROVIDER_CAPABILITIES } from "../integrations/buddy/capabilities";
import { createDiscoveryBackedProviderCapabilities } from "../configured-provider";
import type { BundledProviderId } from "../provider-metadata";
import type { ProviderModuleCapabilities } from "../provider-registry";
import { AGENTIC_CAPABILITIES } from "./capabilities-agentic";
import { AGGREGATOR_CAPABILITIES } from "./capabilities-aggregators";
import { FRONTIER_CAPABILITIES } from "./capabilities-frontier";
import { GENERIC_SPEC_CAPABILITIES } from "./capabilities-generic";
import { LONGTAIL_CAPABILITIES } from "./capabilities-longtail";
import { OAUTH_INTEGRATION_CAPABILITIES } from "./capabilities-oauth-integrations";
import { WEB_AND_CHAT_CAPABILITIES } from "./capabilities-web-and-chat";
import { openAIModelDiscovery } from "./capability-helpers";

export const PROVIDER_CAPABILITIES = {
  ...BUDDY_PROVIDER_CAPABILITIES,
  ...FRONTIER_CAPABILITIES,
  ...AGENTIC_CAPABILITIES,
  ...AGGREGATOR_CAPABILITIES,
  ...OAUTH_INTEGRATION_CAPABILITIES,
  ...LONGTAIL_CAPABILITIES,
  ...WEB_AND_CHAT_CAPABILITIES,
  ...createDiscoveryBackedProviderCapabilities(openAIModelDiscovery),
  ...GENERIC_SPEC_CAPABILITIES,
} satisfies Readonly<Record<BundledProviderId, ProviderModuleCapabilities>>;
