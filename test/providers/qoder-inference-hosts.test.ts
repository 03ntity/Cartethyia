import { expect, test } from "bun:test";
import {
  qoderInferenceCandidates,
  qoderGatewayCandidates,
} from "../../src/providers/integrations/qoder/qoder-realm";

test("device tokens use the ordinary intl gateway order", () => {
  const hosts = qoderInferenceCandidates("intl", "dt-abc123");
  expect(hosts[0]).toBe("https://api1.qoder.sh");
  expect(hosts).toEqual(qoderGatewayCandidates("intl"));
});

test("job tokens prefer api2 before the ordinary gateways", () => {
  const hosts = qoderInferenceCandidates("intl", "jt-abc123");
  expect(hosts[0]).toBe("https://api2.qoder.sh");
  // The ordinary set still follows (api1, then any remaining fallbacks).
  expect(hosts).toContain("https://api1.qoder.sh");
  expect(hosts).toContain("https://api3.qoder.sh");
});

test("unknown token kinds use the ordinary gateway order", () => {
  const hosts = qoderInferenceCandidates("intl", "pt-abc123");
  expect(hosts[0]).toBe("https://api1.qoder.sh");
});

test("cn has exactly one gateway regardless of token kind", () => {
  expect(qoderInferenceCandidates("cn", "jt-abc123")).toEqual([
    "https://gateway.qoder.com.cn",
  ]);
  expect(qoderInferenceCandidates("cn", "dt-abc123")).toEqual([
    "https://gateway.qoder.com.cn",
  ]);
});
