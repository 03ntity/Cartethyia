/**
 * The install hint must match the host OS — a Windows-only `winget` hint on
 * Linux/macOS is nonsense. The hint is keyed on `process.platform` at call
 * time, so the same code serves every OS.
 */
import { afterEach, expect, test } from "bun:test";
import { remoteSupportInstallHint } from "../../src/console/remote-support/contracts";

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");

function fakePlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  if (REAL_PLATFORM) {
    Object.defineProperty(process, "platform", REAL_PLATFORM);
  }
});

test("windows hints use winget", () => {
  fakePlatform("win32");
  expect(remoteSupportInstallHint("cloudflared")).toContain("winget install");
  expect(remoteSupportInstallHint("tailscale")).toContain("winget install");
});

test("macOS hints use brew", () => {
  fakePlatform("darwin");
  expect(remoteSupportInstallHint("cloudflared")).toContain("brew install");
  expect(remoteSupportInstallHint("tailscale")).toContain("brew install");
});

test("linux hints use apt-get", () => {
  fakePlatform("linux");
  expect(remoteSupportInstallHint("cloudflared")).toContain("apt-get install");
  expect(remoteSupportInstallHint("tailscale")).toContain("apt-get install");
});
