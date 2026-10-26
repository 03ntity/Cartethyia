import { describe, expect, test } from "bun:test";
import { resolveAllAddresses } from "../../src/network/ssrf";
import { GatewayError } from "../../src/protocol/gateway-error";

/**
 * Direct DNS behind a broken c-ares resolver.
 *
 * `resolveAllAddresses` resolves through `dns.lookup`, which follows the OS
 * resolver — hosts entries, and a VPN stub that replaces resolv.conf at
 * runtime. `resolve4`/`resolve6` query c-ares directly, so a tunnel resolver
 * that refuses or drops those fails direct egress even while the OS can still
 * answer. That fallthrough is what this suite pins.
 *
 * Nothing here calls `dns.setServers`. It is process-global, and this suite
 * shares a worker with others: installing a broken resolver made any
 * concurrent lookup hang rather than fail, which read as a 15s timeout on a
 * test that had already finished its own work. The fallthrough is instead
 * exercised by supplying the lookup, which is also what makes it
 * deterministic — a real query's outcome depends on the runner's network.
 */
describe("direct DNS behind a broken c-ares resolver", () => {
  test("an aborted lookup rejects promptly and preserves a typed deadline", async () => {
    const controller = new AbortController();
    const deadline = new GatewayError("deadline_exceeded", 504, "request deadline exceeded");
    const pendingLookup = resolveAllAddresses(
      `pending-${Date.now()}.example`,
      controller.signal,
      () => new Promise<readonly { address: string; family: number }[]>(() => undefined),
    );

    controller.abort(deadline);
    await expect(pendingLookup).rejects.toBe(deadline);
  });

  test("uses the OS resolver when the configured c-ares server refuses queries", async () => {
    // The lookup stands in for the OS resolver: it answers where c-ares cannot.
    const addresses = await resolveAllAddresses(
      `${Date.now()}-os-fallback.example`,
      new AbortController().signal,
      async () => [
        { address: "203.0.113.10", family: 4 },
        { address: "203.0.113.11", family: 4 },
      ],
    );
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((address) => address.includes("."))).toBe(true);
    // Every answer is used, not just the first: a resolver that returns
    // several records must not pin the host to one of them.
    expect(addresses).toEqual(["203.0.113.10", "203.0.113.11"]);
  });

  test("prefers IPv4 answers but falls back to whatever the resolver returned", async () => {
    const v4 = await resolveAllAddresses(
      `${Date.now()}-dual.example`,
      new AbortController().signal,
      async () => [
        { address: "2001:db8::1", family: 6 },
        { address: "203.0.113.10", family: 4 },
      ],
    );
    expect(v4).toEqual(["203.0.113.10"]);

    // AAAA-only: dropping those answers would make an IPv6-only upstream
    // unroutable rather than merely unusual.
    const v6 = await resolveAllAddresses(
      `${Date.now()}-only6.example`,
      new AbortController().signal,
      async () => [{ address: "2001:db8::2", family: 6 }],
    );
    expect(v6).toEqual(["2001:db8::2"]);
  });

  test("an IP literal is returned without any lookup", async () => {
    // Short-circuited before the resolver, so a broken one cannot break it.
    const addresses = await resolveAllAddresses(
      "203.0.113.10",
      new AbortController().signal,
      async () => {
        throw new Error("the resolver must not be consulted for an IP literal");
      },
    );
    expect(addresses).toEqual(["203.0.113.10"]);
  });

  test("keeps the resolver failure diagnosable", async () => {
    try {
      await resolveAllAddresses(
        "missing.invalid",
        new AbortController().signal,
        async () => {
          throw new Error("DNS lookup failed: getaddrinfo ENOTFOUND missing.invalid");
        },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("transport_unavailable");
      expect((error as GatewayError).status).toBe(502);
      // The diagnosable part is that the resolver's own reason survives into
      // `details.cause`; which reason is an environment fact, not a contract.
      //
      // This used to pin `"DNS lookup timed out"`, which assumed a resolver that
      // swallows the query. A router that answers NXDOMAIN for `.invalid` — the
      // correct answer for a reserved TLD — fails immediately with
      // `getaddrinfo ENOTFOUND` instead, so the pin failed on a machine whose DNS
      // was working properly. Measured on this host: `192.168.1.1 can't find
      // missing-….invalid: Non-existent domain`.
      //
      // Asserting the shape rather than the one spelling still fails if the cause
      // were dropped entirely, which is the defect this test exists to catch.
      const cause = String((error as GatewayError).details.cause);
      expect(cause.toLowerCase()).toContain("dns");
      return;
    }
    throw new Error("missing hostname resolved");
  });
});
