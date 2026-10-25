// In-memory reservation lease store with expiry-ordered cleanup.
import type { Reservation, RouteCandidate, RoutingRevision } from "./route-model";

/** One heap node: when a lease expires, and which lease it names. */
interface ExpiryNode {
  readonly expiresAt: number;
  readonly leaseId: string;
}

/**
 * Binary min-heap on `expiresAt`.
 *
 * The sweep only ever needs the *earliest* expiring reservations, so a heap
 * answers "which nodes are expired right now" by examining heads only — the
 * previous implementation walked the entire lease map per sweep interval.
 * Stale nodes (a lease released before its expiry) are harmless: the sweep
 * verifies against the map before deleting and drops the node.
 */
class ExpiryHeap {
  private nodes: ExpiryNode[] = [];

  get size(): number {
    return this.nodes.length;
  }

  insert(node: ExpiryNode): void {
    this.nodes.push(node);
    this.bubbleUp(this.nodes.length - 1);
  }

  /** The earliest-expiring node, without removing it. */
  peek(): ExpiryNode | undefined {
    return this.nodes[0];
  }

  pop(): ExpiryNode | undefined {
    const top = this.nodes[0];
    const last = this.nodes.pop();
    if (this.nodes.length > 0 && last !== undefined) {
      this.nodes[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if (this.nodes[current]!.expiresAt >= this.nodes[parent]!.expiresAt) break;
      [this.nodes[current], this.nodes[parent]] = [this.nodes[parent]!, this.nodes[current]!];
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    for (;;) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;
      if (left < this.nodes.length && this.nodes[left]!.expiresAt < this.nodes[smallest]!.expiresAt) {
        smallest = left;
      }
      if (
        right < this.nodes.length &&
        this.nodes[right]!.expiresAt < this.nodes[smallest]!.expiresAt
      ) {
        smallest = right;
      }
      if (smallest === current) break;
      [this.nodes[current], this.nodes[smallest]] = [this.nodes[smallest]!, this.nodes[current]!];
      current = smallest;
    }
  }
}

/**
 * In-memory reservation lease store with expiry-ordered cleanup.
 *
 * Acquisitions insert into an expiry min-heap; the bounded sweep examines only
 * expired heads and verifies the map still holds that exact reservation before
 * deleting (a released entry leaves a harmless stale node behind, dropped on
 * the next sweep that reaches it or by periodic compaction). Stale nodes are
 * compacted when they dominate the heap, so a long stream of short-lived
 * released reservations cannot grow the heap without bound.
 *
 * The sweep interval stays 30 s and the lease TTL stays 30 s by default. Live
 * reservations are not capped — capacity is admission's job, not the lease
 * bookkeeping's. `expires_at` is NOT used to skip admission release: the
 * admission counters protect the real limits and carry their own TTL
 * (`INFLIGHT_TTL_SECONDS`); this map is local bookkeeping only.
 */
export class ReservationManager {
  private leases = new Map<string, Reservation>();
  private expiry = new ExpiryHeap();
  private lastSweepAt = 0;
  private static readonly SWEEP_INTERVAL_MS = 30_000;

  constructor(private readonly now: () => number = Date.now) {}

  private sweepExpired(now: number): void {
    if (now - this.lastSweepAt < ReservationManager.SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    // Only expired heads are examined: once the head expires later than `now`,
    // every remaining node does too, so the loop stops without touching them.
    while (this.expiry.size > 0) {
      const head = this.expiry.peek()!;
      if (head.expiresAt >= now) break;
      this.expiry.pop();
      const lease = this.leases.get(head.leaseId);
      // A released reservation is a harmless stale node: nothing to delete.
      // (Lease identity is the unique lease id, so a reused id cannot alias —
      // the id embeds acquisition time plus randomness.)
      if (lease && lease.expires_at === head.expiresAt && lease.expires_at < now) {
        this.leases.delete(head.leaseId);
      }
    }
    // Periodic compaction of stale nodes (entries whose lease was released or
    // re-keyed before expiry): rebuild the heap only when stale nodes make up
    // the bulk of it, so the common all-live case pays nothing.
    if (this.expiry.size > this.leases.size * 2) {
      const live: ExpiryNode[] = [];
      for (const [leaseId, lease] of this.leases) {
        live.push({ expiresAt: lease.expires_at, leaseId });
      }
      this.expiry = new ExpiryHeap();
      for (const node of live) this.expiry.insert(node);
    }
  }

  acquire(candidate: RouteCandidate, _revision: RoutingRevision, ttlMs = 30_000): Reservation {
    const now = this.now();
    this.sweepExpired(now);
    const lease_id = `${candidate.provider_id}:${candidate.model_id}:${now}:${Math.random().toString(16).slice(2)}`;
    const r: Reservation = {
      candidate,
      lease_id,
      acquired_at: now,
      expires_at: now + ttlMs,
    };
    this.leases.set(lease_id, r);
    this.expiry.insert({ expiresAt: r.expires_at, leaseId: lease_id });
    return r;
  }

  release(lease_id: string): void {
    // The heap node stays until its expiry passes — the sweep treats it as
    // stale and drops it. Cheaper than a heap search per release.
    this.leases.delete(lease_id);
  }

  get(lease_id: string): Reservation | undefined {
    const r = this.leases.get(lease_id);
    if (!r) return undefined;
    if (r.expires_at < this.now()) {
      this.leases.delete(lease_id);
      return undefined;
    }
    return r;
  }

  /** Test/diagnostic seam: current lease count without triggering a sweep. */
  size(): number {
    return this.leases.size;
  }
}
