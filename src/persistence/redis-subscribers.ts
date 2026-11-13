import type { RedisClient } from "./redis";

/**
 * Registry of the duplicated connections `subscribeInvalidation` opens for
 * Redis pub/sub.
 *
 * ioredis puts a connection into subscriber mode permanently, so each
 * subscription needs its own `client.duplicate()` — and `closeRedis()` only
 * knows the main client. Without this registry every subscriber connection
 * outlived the shutdown that closed its parent, and under `bun --hot` (where
 * `globalThis` survives the reload but module state does not) each reload
 * leaked one more connection that nothing could ever reach.
 *
 * The map lives on `globalThis` for exactly that reason: a re-evaluated module
 * must still see — and be able to close — the connections its predecessor
 * opened.
 */

/** The slice of an ioredis subscriber connection the registry needs. */
export interface RedisSubscriber {
  quit(): Promise<unknown>;
}

interface SubscriberEntry {
  readonly subscriber: RedisSubscriber;
  /** Detaches the message listener; the connection itself stays pooled. */
  readonly detach: () => void;
}

declare global {
  // eslint-disable-next-line no-var -- globalThis augmentation requires `var`
  var __cartethyiaRedisSubscribers:
    | Map<RedisClient, Set<SubscriberEntry>>
    | undefined;
}

function registry(): Map<RedisClient, Set<SubscriberEntry>> {
  return (globalThis.__cartethyiaRedisSubscribers ??= new Map());
}

/**
 * Registers one subscription's duplicated connection under `client`.
 * Returns the entry's teardown: it detaches the listener, quits the
 * connection, and drops the client bucket once its last subscriber leaves.
 */
export function trackRedisSubscriber(
  client: RedisClient,
  subscriber: RedisSubscriber,
  detach: () => void,
): () => void {
  const clients = registry();
  let entries = clients.get(client);
  if (entries === undefined) {
    entries = new Set();
    clients.set(client, entries);
  }
  const entry: SubscriberEntry = { subscriber, detach };
  entries.add(entry);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    entries.delete(entry);
    detach();
    if (entries.size === 0) clients.delete(client);
    void subscriber.quit().catch(() => undefined);
  };
}

/**
 * Quits every tracked subscriber connection. Called by `closeRedis()` before
 * the main client goes down, and safe to call when nothing subscribed — the
 * common no-Redis and memory-backend deployments.
 */
export async function closeRedisSubscribers(): Promise<void> {
  const clients = registry();
  const entries = [...clients.values()].flatMap((set) => [...set]);
  clients.clear();
  // Detach first so a message racing the shutdown cannot reach a handler
  // whose process state is already tearing down.
  for (const entry of entries) entry.detach();
  await Promise.allSettled(entries.map((entry) => entry.subscriber.quit()));
}
