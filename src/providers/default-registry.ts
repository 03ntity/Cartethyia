/**
 * Canonical bundled provider registry: the capability rows and the module list
 * every provider subsystem consumes.
 *
 * The implementation is split so the registry can be read without paging one
 * 1000-line file:
 *
 * - `registry/capability-helpers.ts` — the shared builders: configured API-key
 *   specs, OpenAI-compatible discovery, Trae/Qoder discovery, request hooks.
 * - `registry/capabilities-*.ts` — capability rows grouped by provider family.
 * - `registry/capabilities.ts` — composes the groups into
 *   `PROVIDER_CAPABILITIES`.
 * - `registry/modules.ts` — joins the capabilities with the metadata rows into
 *   `BUNDLED_PROVIDER_MODULES` and builds the default `ProviderRegistry`.
 *
 * Every loader entry is a dynamic `import()` closure; nothing in this graph
 * pulls a provider's module into memory until the first request routes to it.
 * This file only re-exports the public surface so existing importers are
 * unchanged.
 */
export { PROVIDER_CAPABILITIES } from "./registry/capabilities";
export { BUNDLED_PROVIDER_MODULES, createDefaultProviderRegistry } from "./registry/modules";
