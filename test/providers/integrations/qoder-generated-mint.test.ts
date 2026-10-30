import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mintQoderGeneratedIdentity,
} from "../../../src/providers/integrations/qoder/qoder-umid";

test("generated identity has the real bridge's token shape (P1gA + 84 base64url)", () => {
  const id = mintQoderGeneratedIdentity("acct-1");
  expect(id.machineToken).toMatch(/^P1gA[A-Za-z0-9_-]{84}$/);
  expect(id.machineToken).toHaveLength(88);
});

test("generated identity is deterministic per account", () => {
  const a = mintQoderGeneratedIdentity("acct-1");
  const b = mintQoderGeneratedIdentity("acct-1");
  expect(a.machineToken).toBe(b.machineToken);
  expect(a.machineType).toBe(b.machineType);
  expect(a.machineCode).toBe(b.machineCode);
});

test("generated identity differs across accounts", () => {
  const a = mintQoderGeneratedIdentity("acct-1");
  const b = mintQoderGeneratedIdentity("acct-2");
  expect(a.machineToken).not.toBe(b.machineToken);
});

test("generated identity token equals sha256(accountId) truncated to 84 base64url", () => {
  const id = mintQoderGeneratedIdentity("acct-1");
  const first = createHash("sha256").update("acct-1").digest("base64url");
  const second = createHash("sha256").update(`acct-1:${first}`).digest("base64url");
  const digest = `${first}${second}`;
  expect(id.machineToken).toBe(`P1gA${digest.slice(0, 84)}`);
});

test("generated identity reports non-VM and generated source", () => {
  const id = mintQoderGeneratedIdentity("acct-1");
  expect(id.isVm).toBe(false);
  expect(id.source).toBe("generated");
});

test("generated machineType/machineCode are 18 hex chars", () => {
  const id = mintQoderGeneratedIdentity("acct-1");
  expect(id.machineType).toMatch(/^[0-9a-f]{18}$/);
  expect(id.machineCode).toMatch(/^[0-9a-f]{18}$/);
});
