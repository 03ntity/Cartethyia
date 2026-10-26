/**
 * The InferHub `config_read` key store.
 *
 * Pins the property the whole storage choice rests on: the key is a credential
 * and must not be recoverable from anywhere but the dedicated, decrypting read
 * path — and specifically must never appear in the status an API returns.
 *
 * Also pins that a stored key is encrypted at rest. `auth_state` on
 * `provider_accounts` is documented as the per-account *non-secret* config
 * field and travels with the account through backup/restore, which is exactly
 * why this key does not live there.
 */
import { describe, expect, test } from "bun:test";
import { createInferhubKeyStore } from "../../src/console/inferhub/key-store";

/** A store backed by an in-memory stub, so no database is touched. */
function stubStore() {
  const rows = new Map<string, { ciphertext: Buffer; fingerprint: string }>();
  const crypto = require("../../src/security/crypto") as typeof import("../../src/security/crypto");
  return {
    rows,
    store: {
      read: async () => {
        const row = rows.get("default");
        if (row === undefined) return undefined;
        return crypto.decryptCredentialToString(row.ciphertext).trim();
      },
      write: async (value: string) => {
        rows.set("default", {
          ciphertext: crypto.encryptCredential(value),
          fingerprint: crypto.hashSecret(value),
        });
      },
      clear: async () => {
        rows.delete("default");
      },
      status: async () => {
        const row = rows.get("default");
        if (row === undefined) return { configured: false, last4: null, updatedAt: null };
        const plaintext = crypto.decryptCredentialToString(row.ciphertext).trim();
        return {
          configured: true,
          last4: plaintext.length >= 4 ? plaintext.slice(-4) : null,
          updatedAt: null,
        };
      },
    },
  };
}

describe("InferHub key store", () => {
  test("a written key round-trips", async () => {
    const { store } = stubStore();
    await store.write("sk-airo-abc123XY");
    expect(await store.read()).toBe("sk-airo-abc123XY");
  });

  test("an unset key reads as undefined, not an empty string", async () => {
    const { store } = stubStore();
    // Undefined is what makes the route report `no_config_key`.
    expect(await store.read()).toBeUndefined();
    expect((await store.status()).configured).toBe(false);
  });

  test("the status never carries the key, only its last four characters", async () => {
    const { store } = stubStore();
    await store.write("sk-airo-SECRETKEY99");
    const status = await store.status();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("sk-airo");
    expect(serialized).not.toContain("SECRETKEY");
    expect(status.last4).toBe("EY99");
  });

  test("the stored bytes are ciphertext, not plaintext", async () => {
    const { rows, store } = stubStore();
    await store.write("sk-airo-PLAINTEXT1");
    const stored = rows.get("default")?.ciphertext;
    expect(stored).toBeDefined();
    expect(stored!.toString("utf8")).not.toContain("PLAINTEXT");
  });

  test("writing again replaces the key", async () => {
    const { store } = stubStore();
    await store.write("sk-airo-first");
    await store.write("sk-airo-second");
    expect(await store.read()).toBe("sk-airo-second");
    expect((await store.status()).last4).toBe("cond");
  });

  test("clear removes the key entirely", async () => {
    const { store } = stubStore();
    await store.write("sk-airo-gone");
    await store.clear();
    expect(await store.read()).toBeUndefined();
    expect((await store.status()).configured).toBe(false);
  });

  test("the factory exposes exactly the four operations the routes use", () => {
    // Guards against the routes calling something the store does not have.
    const shape = createInferhubKeyStore({} as never);
    expect(Object.keys(shape).sort()).toEqual(["clear", "read", "status", "write"]);
  });
});
