// Shared console route-factory config. Every console subdomain receives the
// same injected collaborators from the router; the one universal member is the
// access resolver, so the per-domain `XConfig` interfaces extend this instead
// of restating it.
import type { ConsoleAccessResolver } from "../auth/access";

export interface ConsoleRouteConfig {
  readonly accessResolver: ConsoleAccessResolver;
}
