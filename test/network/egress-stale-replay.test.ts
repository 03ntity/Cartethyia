/**
 * Stale-socket replay: egress ownership and double-delivery safety.
 *
 * The replay is the one dial in a request that never re-enters the hop's
 * setup, so these pin the properties that fail silently: a socks/proxy pool
 * the replay quietly drops to direct egress (egress-policy + accounting
 * leak), a POST replayed after the upstream may already have processed it,
 * and a pool dial replayed without ever facing the SSRF policy locally.
 */
import { describe, expect, test } from "bun:test";
import { createValidatedFetch, socksDispatchersFor } from "../../src/network/egress/fetch";
import { createHttpProxyAgent, createSocks5Agent } from "../../src/network/pool/agent";

/** Resolver that answers every hostname with one fixed address. */
function resolver(address: string): (hostname: string) => Promise<readonly string[]> {
  return async (hostname: string) => {
    void hostname;
    return [address];
  };
}

function socketError(code: string): Error {
  const e = new Error(`socket error ${code}`);
  (e as { code?: string }).code = code;
  return e;
}

interface Seen {
  url: string;
  init: RequestInit;
}

/** Records dials; the first `failures` calls throw a proven stale-socket error. */
function flakyFetcher(
  seen: Seen[],
  failures = 1,
  error: Error = socketError("ECONNRESET"),
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), init: init ?? {} });
    if (seen.length <= failures) throw error;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("stale-socket replay keeps the owning egress", () => {
  test("a socks replay stays on the socks pool on a fresh dispatcher", async () => {
    const agent = createSocks5Agent("socks5://127.0.0.1:5858", undefined, {});
    expect(agent.socks).toBeDefined();
    const nativeSeen: Seen[] = [];
    const socksSeen: Seen[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      agent,
      fetchFn: flakyFetcher(nativeSeen),
      socksFetch: flakyFetcher(socksSeen) as unknown as (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => Promise<Response>,
    });
    const response = await fetcher("https://api.example/v1/models");
    expect(response.status).toBe(200);
    // The replay must never fall back to the native/direct dialer.
    expect(nativeSeen).toEqual([]);
    expect(socksSeen).toHaveLength(2);
    const pair = socksDispatchersFor(agent.socks!);
    // First attempt on the pooled dispatcher…
    expect((socksSeen[0]!.init as unknown as { dispatcher?: unknown }).dispatcher).toBe(pair.agent);
    // …the replay on the fresh instance of the same socks identity.
    expect((socksSeen[1]!.init as unknown as { dispatcher?: unknown }).dispatcher).toBe(pair.fresh);
    expect(pair.fresh).not.toBe(pair.agent);
  });

  test("a pool replay keeps the proxy and never falls back to direct", async () => {
    const agent = createHttpProxyAgent("http://proxy.internal:8080", undefined, {});
    expect(agent.relayEndpoint).toBeUndefined();
    const seen: Seen[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      agent,
      fetchFn: flakyFetcher(seen),
    });
    const response = await fetcher("https://api.example/v1/models");
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    for (const attempt of seen) {
      const init = attempt.init as unknown as { proxy?: string; dispatcher?: unknown };
      // The proxy owns the dial on both attempts…
      expect(init.proxy).toBe(agent.proxyUrl);
      // …and no direct dispatcher override rides along on the replay.
      expect(init.dispatcher).toBeUndefined();
    }
  });

  test("a direct replay still gets a fresh direct dispatcher", async () => {
    const seen: Seen[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      fetchFn: flakyFetcher(seen),
    });
    const response = await fetcher("https://api.example/v1/models");
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    // The first attempt is a plain dial; the replay adds the fresh-socket
    // dispatcher so the retry never reuses the poisoned pooled connection.
    expect((seen[0]!.init as unknown as { dispatcher?: unknown }).dispatcher).toBeUndefined();
    expect((seen[1]!.init as unknown as { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect((seen[1]!.init as unknown as { proxy?: string }).proxy).toBeUndefined();
  });

  test("a pool dial passes the SSRF policy before any replay", async () => {
    const agent = createHttpProxyAgent("http://proxy.internal:8080", undefined, {});
    const seen: Seen[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      // The target advertises a loopback address. The pool dial itself is
      // only advisory-checked, but the replay must refuse to dial again —
      // without the gate it would be the one unvalidated dial of the request.
      resolveFn: resolver("127.0.0.1"),
      agent,
      fetchFn: flakyFetcher(seen, Number.POSITIVE_INFINITY),
    });
    await expect(fetcher("https://api.example/v1/models")).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe("stale-socket replay never double-submits", () => {
  test("a POST + headers timeout is never replayed", async () => {
    const seen: Seen[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      fetchFn: flakyFetcher(seen, Number.POSITIVE_INFINITY, socketError("UND_ERR_HEADERS_TIMEOUT")),
    });
    await expect(
      fetcher("https://api.example/v1/chat", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/socket error/);
    // One dial only: the upstream may already hold and have processed the
    // POST, and a replay would deliver it twice.
    expect(seen).toHaveLength(1);
  });

  test("a GET + headers timeout replays exactly once", async () => {
    const seen: Seen[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      fetchFn: flakyFetcher(seen, 1, socketError("UND_ERR_HEADERS_TIMEOUT")),
    });
    const response = await fetcher("https://api.example/v1/models");
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  test("every idempotent method may replay; POST may not", async () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      const seen: Seen[] = [];
      const fetcher = createValidatedFetch({
        policy: {},
        resolveFn: resolver("93.184.216.34"),
        fetchFn: flakyFetcher(seen),
      });
      const response = await fetcher("https://api.example/v1/resource", { method });
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(2);
    }
  });
});
