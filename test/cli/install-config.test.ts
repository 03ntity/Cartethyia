import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertModeChangeAllowed, mergeEnvText, writeEnvAtomic } from "../../scripts/install/config";

test("env merge preserves comments, custom values, and newline style", () => {
  const original = "# keep\r\nPORT=1\r\nCUSTOM=value\r\n";
  const result = mergeEnvText(original, { PORT: "2", CARTETHYIA_DB_MODE: "lite" });
  expect(result).toBe("# keep\r\nPORT=2\r\nCUSTOM=value\r\nCARTETHYIA_DB_MODE=lite\r\n");
  expect(mergeEnvText("", { PORT: "12800" })).toBe("PORT=12800\n");
});

test("duplicate managed keys and multiline values are rejected", () => {
  expect(() => mergeEnvText("PORT=1\nPORT=2\n", { PORT: "3" })).toThrow("Duplicate managed");
  expect(() => mergeEnvText("", { PORT: "1\n2" })).toThrow("contains a newline");
});

test("mode changes require backup migration", () => {
  expect(() => assertModeChangeAllowed({ CARTETHYIA_DB_MODE: "lite" }, "full")).toThrow("Export a JSON backup");
  expect(() => assertModeChangeAllowed({ CARTETHYIA_DB_MODE: "lite" }, "lite")).not.toThrow();
});

test("atomic env writes preserve an existing secret and leave no temporary file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "carte-env-test-"));
  const path = join(dir, ".env");
  try {
    await writeFile(path, "CARTETHYIA_ENCRYPTION_KEY=existing\nCUSTOM=keep\n");
    await writeEnvAtomic(path, { PORT: "12800" });
    const result = await readFile(path, "utf8");
    expect(result).toContain("CARTETHYIA_ENCRYPTION_KEY=existing");
    expect(result).toContain("CUSTOM=keep");
    expect(result).toContain("PORT=12800");
    expect(await Bun.file(join(dir, ".env.tmp")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
