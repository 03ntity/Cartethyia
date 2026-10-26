/**
 * The embedded backend compiles one statement per query execution unless
 * something caches it.
 *
 * Drizzle's bun-sqlite session calls `client.prepare(query.sql)` for every
 * execution (`SQLiteBunSession.prepareQuery`), and `Database.prepare` — unlike
 * `Database.query` — caches nothing. An idle lite-mode gateway runs ~19
 * scheduled tasks, each executing the same handful of queries, so the uncached
 * path compiled a fresh statement per tick and never finalized one: RSS climbed
 * for hours with no traffic at all.
 *
 * These tests pin the fix at the wrapper: identical SQL must return the same
 * statement object, different SQL must not, and the cache must be bounded
 * rather than becoming a leak of its own.
 */
import { expect, test } from "bun:test";
import type { Statement } from "bun:sqlite";
import { createSqliteDatabase } from "../../src/persistence/db-sqlite";

/** Cache bound in `src/persistence/db-sqlite.ts`; not exported. */
const SQLITE_STATEMENT_CACHE_MAX = 256;

test("identical SQL returns the same compiled statement", () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    const first = sqlite.prepare("SELECT 1");
    const second = sqlite.prepare("SELECT 1");
    // Reference equality, not a deep compare: a second `prepare` returning an
    // equal-but-distinct object means a second statement was compiled, which is
    // exactly the growth this cache exists to stop.
    expect(second).toBe(first);
    expect((first as Statement).get()).toEqual({ 1: 1 });
  } finally {
    sqlite.close(true);
  }
});

test("different SQL returns different statements", () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    const one = sqlite.prepare("SELECT 1");
    const two = sqlite.prepare("SELECT 2");
    expect(two).not.toBe(one);
    expect((one as Statement).get()).toEqual({ 1: 1 });
    expect((two as Statement).get()).toEqual({ 2: 2 });
  } finally {
    sqlite.close(true);
  }
});

test("the cache is bounded, so a distinct query set cannot grow it forever", () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    const first = sqlite.prepare("SELECT 0");
    // One more than the bound, so the first statement is evicted by the time
    // it is asked for again — the map holds at most `MAX` entries throughout.
    for (let index = 1; index <= SQLITE_STATEMENT_CACHE_MAX + 10; index += 1) {
      sqlite.prepare(`SELECT ${index}`);
    }
    const recompiled = sqlite.prepare("SELECT 0");
    // Evicted: a cache that still held it would be an unbounded map, which is
    // a leak traded for a leak.
    expect(recompiled).not.toBe(first);
    expect((recompiled as Statement).get()).toEqual({ 0: 0 });
  } finally {
    sqlite.close(true);
  }
});

test("a cached statement still converts a Date binding", () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    // The wrapper that ISO-converts `Date` bindings is installed at compile
    // time, so a cache hit must return an already-wrapped statement rather than
    // a bare one. bun:sqlite rejects a raw Date outright, so hitting the cache
    // on the second call would throw if the wrapper were lost.
    const at = new Date("2026-10-07T06:00:00.000Z");
    const statement = sqlite.prepare("SELECT ? AS at");
    expect((sqlite.prepare("SELECT ? AS at") as Statement).get(at)).toEqual({ at: at.toISOString() });
    expect((statement as Statement).get(at)).toEqual({ at: at.toISOString() });
  } finally {
    sqlite.close(true);
  }
});

test("SQL whose now() is inlined is not cached", () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    // `now()` is rewritten to a literal timestamp before compilation, so the
    // text differs per call. Caching it would pin every later execution to the
    // value the first one happened to inline — a query that silently stops
    // tracking the clock.
    const first = sqlite.prepare("SELECT now() AS at");
    const second = sqlite.prepare("SELECT now() AS at");
    expect(second).not.toBe(first);
  } finally {
    sqlite.close(true);
  }
});
