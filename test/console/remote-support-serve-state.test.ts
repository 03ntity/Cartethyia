/**
 * A stopped tunnel must not keep reporting itself as active.
 *
 * Tailscale's node and its serve are separate: stopping the tunnel empties
 * `serve status` back to `{}` while the node stays `Online`. Reading the node
 * alone as "still active" left the toggle on and a stale link in the UI after
 * the operator had stopped it, and the link no longer resolved.
 *
 * These pin the shape rules, which are the whole decision.
 */
import { expect, test } from "bun:test";
import { serveStatusHasHandler } from "../../src/console/remote-support/service";

test("an empty serve status publishes nothing", () => {
  // What `serve status --json` answers once the tunnel is stopped. The node is
  // still online at this point, so this is the only signal that says "stopped".
  expect(serveStatusHasHandler({})).toBe(false);
});

test("a serve with a web handler is publishing", () => {
  expect(
    serveStatusHasHandler({
      TCP: { "443": { HTTPS: true } },
      Web: { "host.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:12800" } } } },
    }),
  ).toBe(true);
});

test("a serve with only a TCP forward is publishing", () => {
  // Not every serve is a web handler; a bare TCP forward is still a tunnel.
  expect(serveStatusHasHandler({ TCP: { "443": { HTTPS: true } } })).toBe(true);
});

test("an unparseable or non-object body is not publishing", () => {
  // Failing closed: an address claimed without evidence would leave a link the
  // operator cannot open.
  expect(serveStatusHasHandler(null)).toBe(false);
  expect(serveStatusHasHandler("{}")).toBe(false);
  expect(serveStatusHasHandler([])).toBe(false);
});
