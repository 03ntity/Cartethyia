/**
 * Minimal ambient types for the `undici` dispatcher used by SOCKS5 pool
 * egress. `undici` ships no type declarations and the project does not carry
 * `@types/undici`; only the two surfaces used here are described.
 */
declare module "undici" {
  /** Options accepted by undici's fetch (superset of RequestInit). */
  export interface UndiciRequestInit extends RequestInit {
    readonly dispatcher?: Dispatcher;
  }

  /** A dispatcher that can be supplied to undici fetch. */
  export interface Dispatcher {
    dispatch?: unknown;
  }

  export class Agent implements Dispatcher {
    constructor(
      options?: {
        readonly connect?: (
          opts: Record<string, unknown>,
        ) => Promise<unknown>;
      },
    );
    dispatch?: unknown;
  }

  export function fetch(
    input: RequestInfo | URL,
    init?: UndiciRequestInit,
  ): Promise<Response>;
}

