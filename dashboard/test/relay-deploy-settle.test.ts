/**
 * The relay deploy modal's settle behavior.
 *
 * A deploy that succeeded is finished work: the relay is registered as a pool
 * and the pool list behind the dialog shows it, so the dialog closes. A failure
 * that invalidated the session — a revoked or mistyped Cloudflare token, which
 * surfaces as an authentication error and signs the console out — closes too,
 * because retrying inside the form can only repeat it.
 *
 * What must NOT close is an ordinary failure: a taken project name or a
 * transient deploy error is one edited field from succeeding, and discarding
 * what the operator typed would be the wrong trade. `relay-deploy-settle.ts`
 * holds the predicate so this file can lock the boundary without mounting the
 * dialog.
 */
import { describe, expect, test } from "bun:test";
import { isSessionInvalidatedError } from "../src/components/relay-deploy-settle";

describe("relay deploy settle", () => {
  test("an authentication failure closes the dialog", () => {
    expect(isSessionInvalidatedError({ status: 401 })).toBe(true);
    expect(isSessionInvalidatedError({ status: 403 })).toBe(true);
    expect(isSessionInvalidatedError({ status: 401, code: "unauthorized" })).toBe(true);
  });

  test("a code alone is enough when the status is absent", () => {
    expect(isSessionInvalidatedError({ code: "unauthorized" })).toBe(true);
    expect(isSessionInvalidatedError({ code: "authentication_failed" })).toBe(true);
    expect(isSessionInvalidatedError({ code: "forbidden" })).toBe(true);
  });

  test("an ordinary failure keeps the dialog open for a retry", () => {
    // A taken project name, a transient deploy error, a network fault: all are
    // one corrected field from succeeding.
    expect(isSessionInvalidatedError({ status: 400 })).toBe(false);
    expect(isSessionInvalidatedError({ status: 409 })).toBe(false);
    expect(isSessionInvalidatedError({ status: 500 })).toBe(false);
    expect(isSessionInvalidatedError({ status: 502 })).toBe(false);
    expect(isSessionInvalidatedError({ code: "project_name_taken" })).toBe(false);
    expect(isSessionInvalidatedError({ message: "deploy failed" })).toBe(false);
  });

  test("a shapeless error never closes the dialog", () => {
    expect(isSessionInvalidatedError(undefined)).toBe(false);
    expect(isSessionInvalidatedError(null)).toBe(false);
    expect(isSessionInvalidatedError(new Error("boom"))).toBe(false);
    expect(isSessionInvalidatedError("401")).toBe(false);
  });
});
