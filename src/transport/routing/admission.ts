// Routing inflight admission controllers (in-memory and Redis-backed).
import { metrics } from "../../observability/metrics";
import { resolveInflightTtlSeconds } from "../../config/timeouts";
import { redisEvalNumber, type RedisClient } from "../../persistence/redis";
import type {
  AdmissionController,
  AdmissionDecision,
  Reservation,
  RouteCandidate,
} from "./route-model";

/**
 * Admission bucket identity. Account-scoped so each account of a provider
 * enforces its own concurrency ceiling; candidates without an account id
 * (credential-less providers) fall back to the provider:model bucket.
 */
/**
 * The admission bucket one candidate draws from.
 *
 * Bucket identity is `provider:model[:account][:ownerTenant]`:
 * - A candidate with no account (credential-less provider) buckets per
 *   provider:model.
 * - A **shared** account (`owner_tenant_id` null) is one bucket across all
 *   tenants — the account is pool-wide, so its concurrency ceiling is global.
 * - A **tenant-owned** account is scoped to its owner tenant, so two tenants
 *   cannot drain each other's ceiling on an account only one of them owns.
 *
 * Exported so the router can order candidates by the same counters admission
 * enforces against: a second copy of this format would drift and quietly
 * deprioritize the wrong accounts.
 */
export function admissionKey(candidate: RouteCandidate): string {
  const base = `${candidate.provider_id}:${candidate.model_id}`;
  if (candidate.provider_account_id === undefined) return base;
  const account = `${base}:${candidate.provider_account_id}`;
  return candidate.owner_tenant_id === undefined || candidate.owner_tenant_id === null
    ? account
    : `${account}:${candidate.owner_tenant_id}`;
}

/**
 * What one candidate's configured ceiling tells admission to do, before any
 * back end has looked at its counter.
 */
type AdmissionDirective =
  | { readonly kind: "unlimited" }
  | { readonly kind: "reject" }
  | { readonly kind: "bounded"; readonly limit: number };

/**
 * The one admission policy, shared by both controllers.
 *
 * Both back ends must reach the same three-way decision for one candidate:
 * no configured ceiling (account and routing panel both empty) means the
 * account is UNLIMITED — still counted, so inflight stays observable, but
 * never rejected; a non-positive ceiling is a configured zero, so every
 * request is rejected; and reaching the ceiling rejects. Only the comparison
 * itself is back-end specific (a `Map` read here, an atomic Lua `GET`/`INCR`
 * for Redis), so the decision and the rejection it produces live in one
 * place and the two deployments cannot report different telemetry for the
 * same input.
 */
function admissionDirective(candidate: RouteCandidate): AdmissionDirective {
  const limit = candidate.max_inflight;
  if (limit === undefined) return { kind: "unlimited" };
  if (limit <= 0) return { kind: "reject" };
  return { kind: "bounded", limit };
}

/** The one shape of an admission rejection: the metric, then the decision. */
function capacityRejected(): AdmissionDecision {
  metrics.proxy_admission_total.inc(1, { reason: "provider_capacity" });
  // `reason` is the routing-internal label, not the public code. It stays the
  // string the router and its tests match on; the envelope code is
  // `provider_capacity_exhausted` so this layer cannot be confused with an
  // API-key `max_concurrent` rejection (which owns `capacity_exhausted`).
  return { admitted: false, reason: "capacity_exhausted" };
}

export class InMemoryAdmissionController implements AdmissionController {
  private inflight = new Map<string, number>();
  readAccountInflight(
    candidates: readonly RouteCandidate[],
  ): ReadonlyMap<string, number> {
    // Dedupe buckets: one candidate list often repeats a bucket (combo members
    // fan out to several candidates on one account), and the caller only needs
    // one count per bucket to make its ordering decision.
    const snapshot = new Map<string, number>();
    for (const candidate of candidates) {
      const key = admissionKey(candidate);
      if (snapshot.has(key)) continue;
      const value = this.inflight.get(key) ?? 0;
      if (value > 0) snapshot.set(key, value);
    }
    return snapshot;
  }
  async admit(candidate: RouteCandidate): Promise<AdmissionDecision> {
    // Bucket per ACCOUNT, not per provider:model. A provider with N accounts
    // holds N independent ceilings, so total inflight scales with the account
    // count instead of every account sharing one pool-wide bucket (which made
    // round-robin look "sticky": account 2+ was always admitted-rejected).
    const key = admissionKey(candidate);
    const directive = admissionDirective(candidate);
    if (directive.kind === "reject") return capacityRejected();
    const cur = this.inflight.get(key) ?? 0;
    if (directive.kind === "bounded" && cur >= directive.limit) return capacityRejected();
    this.inflight.set(key, cur + 1);
    return { admitted: true };
  }

  async release(reservation: Reservation): Promise<void> {
    const key = admissionKey(reservation.candidate);
    const cur = this.inflight.get(key) ?? 1;
    // Delete at zero rather than storing it: keys are per account/model and
    // models churn, so retained zeroes would grow the map for the process
    // lifetime. Absent reads as zero everywhere this map is consulted.
    if (cur <= 1) this.inflight.delete(key);
    else this.inflight.set(key, cur - 1);
  }
}

/**
 * Redis-backed admission controller for routing inflight. Replaces the
 * in-memory controller so multi-instance deployments enforce one shared
 * per-account inflight bucket — mirroring the in-memory controller's
 * account-scoped ceiling. The TTL self-heals crash-orphaned increments without
 * the full lease machinery (over-inflating a route slot is bounded and less
 * harmful than corrupting quota counters).
 *
 * The TTL is the shared {@link resolveInflightTtlSeconds}, not a local
 * constant: it must exceed the longest legitimate slot hold, which is the
 * upstream deadline plus the stream stall budget. A fixed 60s expired a slot
 * mid-stream for any request running longer than a minute, so a second request
 * could admit against the freed slot and exceed the configured ceiling. The
 * pool selector holds its slot for the same request duration and derives the
 * same value, so both admit on one invariant.
 */
const INFLIGHT_TTL_SECONDS = resolveInflightTtlSeconds();

const ADMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then return 0 end
local next = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return next
`;

/** Counts an admission without any ceiling (unlimited account). */
const UNLIMITED_ADMIT_SCRIPT = `
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return 1
`;
const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 0 then return 0 end
local next = redis.call('DECR', KEYS[1])
if next <= 0 then redis.call('DEL', KEYS[1]) end
return next
`;

export class RedisAdmissionController implements AdmissionController {
  constructor(private readonly redis: RedisClient) {}

  private key(candidate: RouteCandidate): string {
    return `admission:inflight:${admissionKey(candidate)}`;
  }

  async admit(candidate: RouteCandidate): Promise<AdmissionDecision> {
    const directive = admissionDirective(candidate);
    if (directive.kind === "reject") return capacityRejected();
    // The unlimited path counts with the TTL self-heal but never compares
    // against a ceiling, so no limit argument ever reaches the ceiling script.
    const result = await redisEvalNumber(
      this.redis,
      directive.kind === "unlimited" ? UNLIMITED_ADMIT_SCRIPT : ADMIT_SCRIPT,
      1,
      this.key(candidate),
      ...(directive.kind === "unlimited"
        ? [INFLIGHT_TTL_SECONDS]
        : [directive.limit, INFLIGHT_TTL_SECONDS]),
    );
    if (directive.kind === "bounded" && result === 0) return capacityRejected();
    return { admitted: true };
  }

  async release(reservation: Reservation): Promise<void> {
    await redisEvalNumber(this.redis, RELEASE_SCRIPT, 1, this.key(reservation.candidate));
  }

  async readAccountInflight(
    candidates: readonly RouteCandidate[],
  ): Promise<ReadonlyMap<string, number>> {
    // Candidate-scoped exact reads replace the fleet-wide `KEYS` + unbounded
    // `MGET` this method used to run on every `plan()` that had any bounded
    // candidate. `KEYS` is O(keyspace) and blocks the single-threaded Redis
    // server; on a shared box the scan was measured as the dominant planning
    // cost. The keys here are exactly the buckets the caller is about to order
    // candidates by, read in bounded sequential chunks.
    //
    // `KEYS` and `SCAN` stay banned on this path by construction: neither can
    // answer "what are the values of these N known keys" in fewer than
    // O(keyspace) server work, and a fleet-wide inflight snapshot has no
    // request-path consumer left. (If one ever appears, it belongs in a
    // maintenance task using `SCAN` with `COUNT`, never here.)
    const buckets = [...new Set(candidates.map(admissionKey))];
    if (buckets.length === 0) return new Map();
    const keys = buckets.map((bucket) => `admission:inflight:${bucket}`);
    const values: number[] = [];
    // Bounded sequential chunks: one huge MGET would move the unbounded
    // payload problem from the KEYS call to the MGET call. 256 keys keeps a
    // single command payload small while the round trips stay proportional to
    // the (deduped, candidate-bounded) request size.
    for (let offset = 0; offset < keys.length; offset += MGET_CHUNK_SIZE) {
      const chunk = keys.slice(offset, offset + MGET_CHUNK_SIZE);
      const raw = (await this.redis.mget(...chunk)) as (string | null)[];
      for (const value of raw) values.push(Number(value ?? 0));
    }
    const snapshot = new Map<string, number>();
    for (const [index, bucket] of buckets.entries()) {
      const value = values[index] ?? 0;
      if (Number.isFinite(value) && value > 0) {
        snapshot.set(bucket, value);
      }
      // The Redis controller's counter keys are TTL self-healing, so a bucket
      // absent from the reply reads as zero and is omitted — the projection
      // both controllers share: positive-finite counts only, unprefixed names.
    }
    return snapshot;
  }
}

/** Sequential MGET chunk bound for {@link RedisAdmissionController.readAccountInflight}. */
const MGET_CHUNK_SIZE = 256;
