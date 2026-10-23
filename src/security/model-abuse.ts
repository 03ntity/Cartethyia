/**
 * Model-abuse strikes: a graduated response to a client that repeatedly asks
 * for a model it may not use.
 *
 * A gateway request names a model; when that name is outside the key's
 * allowlist, denylisted, or resolves to nothing, the request is rejected 404
 * `model_not_found`. That rejection is a normal answer to one mistake — but a
 * client that keeps hitting it is not making a mistake, it is probing, and it
 * costs the operator real work: every attempt lands as a failed row in the
 * console and the share page, burying the traffic that matters.
 *
 * So the rejection escalates. Each invalid-model attempt inside the sliding
 * window records a timestamp against the caller's client IP; crossing the
 * threshold bans that IP. A valid request does not reset the window. Attempts
 * older than the window stop counting, so old probes do not accumulate forever.
 *
 * **The ban is keyed on the client address and the API key that was used.**
 *
 * Each half alone was the wrong trade. The address alone: a key is shared by
 * everyone behind a template (every recipient of a share link, every member of
 * a team), so banning the address punishes callers that did nothing. The key
 * alone: the address that actually probed mints a fresh key and carries on.
 * Together they block the caller that earned it and nobody else.
 *
 * **A known gap, deliberately left open.** A share key's children are issued per
 * recipient, so banning `address|child` leaves that recipient able to enroll a
 * *new* child key from the same address and continue. Closing it by banning the
 * address (or the share template) would take down every other recipient behind
 * the same NAT — exactly the collateral this scoping exists to avoid. The
 * console's "ban every key from this IP" is the operator's opt-in for the case
 * where the address, not the credential, is the problem.
 *
 * **A ban lapses after its TTL** (`CARTETHYIA_MODEL_BAN_TTL_MS` for the
 * graduated path, or the duration an operator chose) rather than staying until
 * someone lifts it, so a false positive heals without human intervention. The
 * console can still lift one early.
 *
 * Fail-open on store outage: unlike admission (where admitting an unauthorized
 * request is worse than refusing a valid one), a strike layer that cannot read
 * its counter must not refuse a legitimate request. A store error is swallowed
 * and the request proceeds; the worst case is a missed strike, never a blocked
 * client.
 */
import { GatewayError } from "../protocol/gateway-error";
import { redisEvalNumber, redisEvalTuple, type RedisClient } from "../persistence/redis";

/**
 * A ban is keyed on the address **and** the API key that was used, so banning
 * one caller behind a shared address does not take down everyone else on it.
 *
 * The pair is stored as one opaque string rather than two fields because both
 * stores address a ban by a single member: Redis keeps bans in one sorted set
 * scored by expiry, and a composite key is the only way to keep that a single
 * O(1) lookup. `|` is the separator because neither an IP nor a uuid can
 * contain it, so the split is unambiguous.
 */
export function banIdentity(ip: string, apiKeyId?: string | null): string {
  const key = apiKeyId ?? "";
  // No key is the *bare address*, not `address|` with an empty tail: a ban
  // written before scoping existed is exactly this string, and a rolling
  // deploy has to read those back as what they always were — a ban on every
  // key from that address. Giving the two shapes different spellings would
  // silently un-ban every caller the running deployment is blocking.
  return key.length > 0 ? `${ip}|${key}` : ip;
}

/**
 * The address-wide member for `ip`: the same shape, with no key.
 *
 * A ban recorded under it blocks every key used from that address. It is what
 * an operator picks when the address itself is the problem — and, because it
 * is the bare address, it is also the member every pre-scoping ban already
 * uses.
 */
export function addressBanIdentity(ip: string): string {
  return ip;
}

/** Splits a ban member back into the address and the key it names. */
export function parseBanIdentity(
  identity: string,
): { readonly ip: string; readonly apiKeyId: string | null } {
  const at = identity.indexOf("|");
  // A member with no separator is the bare address: a ban on every key from it,
  // whether an operator asked for that or the ban predates scoping.
  if (at < 0) return { ip: identity, apiKeyId: null };
  const key = identity.slice(at + 1);
  return { ip: identity.slice(0, at), apiKeyId: key.length > 0 ? key : null };
}

/**
 * The TTL behind the "Permanent" choice.
 *
 * Not literally infinite, because both stores lapse a ban by comparing its
 * expiry to now — an unbounded ban would need a second, different mechanism
 * and a second way to get it wrong. Fifty years is past the point where
 * "lapses on its own" means anything, and the ban is still liftable from the
 * console, which is the property that actually matters: a ban an operator
 * cannot undo is a trap, not a deterrent.
 */
export const PERMANENT_BAN_TTL_MS = 50 * 365 * 24 * 60 * 60_000;

/**
 * Whether a ban's remaining time can only be the permanent choice.
 *
 * Derived rather than stored, because the stores carry a ban as one scored
 * member with no room for a flag, and a second parallel structure would be a
 * second thing to keep in sync. The longest chooseable non-permanent ban is a
 * week, so a remaining time measured in years has exactly one origin.
 */
export function isPermanentBan(expiresAt: number, now: number): boolean {
  return expiresAt - now > 30 * 24 * 60 * 60_000;
}

/** A ban row, for the console. */
export interface ModelAbuseBan {
  /** The client address the ban is keyed on. */
  readonly ip: string;
  /**
   * The API key the ban is scoped to, or `null` for every key from that
   * address. `null` is the blunt instrument: it is what the graduated strike
   * path used to always do, and what an operator still picks when the address
   * itself is the problem.
   */
  readonly apiKeyId: string | null;
  /** Model-abuse policy that triggered this ban. */
  readonly reason: "repeated_invalid_model_requests";
  /** Epoch ms the ban lapses on its own. */
  readonly expiresAt: number;
  /** Whether this is the "Permanent" choice rather than a timed one. */
  readonly permanent: boolean;
  /** The opaque member the store addresses this ban by, for `unban`. */
  readonly identity: string;
}

/** One strike decision, as the store sees it. */
export interface ModelAbuseAttempt {
  readonly ip: string;
  /**
   * The key this attempt authenticated with, if one was resolved. Scopes both
   * the strike window and the ban it escalates to, so a key shared by several
   * callers does not let one of them spend another's budget.
   */
  readonly apiKeyId?: string | null;
  /** Whether this attempt named a model the key may use. */
  readonly valid: boolean;
  /** Invalid attempts inside the window that trigger a ban. */
  readonly threshold: number;
  /** Sliding window (ms) that keeps an invalid attempt countable. */
  readonly windowMs: number;
  /** How long (ms) a ban lasts before it lapses on its own. */
  readonly banTtlMs: number;
}

/** What one strike decision decided. */
export interface ModelAbuseOutcome {
  /** The IP is banned, now or already. */
  readonly banned: boolean;
  /** Invalid attempts still inside the window, after this one. `0` when valid. */
  readonly strikes: number;
  /** This attempt crossed the threshold and recorded the ban. */
  readonly bannedNow: boolean;
}

/**
 * The `{banned, strikes, bannedNow}` tuple the script returns. A value of the
 * wrong length or with a non-finite member means the script and its caller
 * drifted; reading it as a decision would ban or admit on garbage, so it
 * throws — the service maps that to a swallowed fail-open, never a rejection.
 */
function decodeOutcome(raw: readonly unknown[]): ModelAbuseOutcome {
  if (raw.length !== 3) {
    throw new Error(`[model-abuse] script returned ${raw.length} elements, expected 3`);
  }
  const [bannedRaw, strikesRaw, bannedNowRaw] = raw.map((value) => Number(value));
  const banned = bannedRaw ?? NaN;
  const strikes = strikesRaw ?? NaN;
  const bannedNow = bannedNowRaw ?? NaN;
  if (!Number.isFinite(banned) || !Number.isFinite(strikes) || !Number.isFinite(bannedNow)) {
    throw new Error(`[model-abuse] script returned a non-finite value: ${String(raw)}`);
  }
  return { banned: banned === 1 || bannedNow === 1, strikes, bannedNow: bannedNow === 1 };
}

export interface ModelAbuseStore {
  /**
   * One atomic strike decision: reads the ban and records an invalid attempt
   * in the caller's sliding window. A valid attempt changes nothing.
   *
   * The window is keyed on the address **and** the key, so two callers sharing
   * one address each get their own budget: a strike is something one caller
   * did, and merging them let a busy caller escalate a ban onto a quiet one.
   */
  record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome>;
  /**
   * O(1) ban lookup for the pre-parse gate, by the opaque member
   * {@link banIdentity} builds.
   *
   * True when that member is banned **or** the address-wide member is — a ban
   * scoped to no key blocks every key from the address, and a ban written
   * before scoping existed is such a member. Both are read here rather than at
   * the call site because the store owns where a ban lives, and a second
   * lookup outside it would be a second round trip per request on Redis.
   */
  isBanned(identity: string): Promise<boolean>;
  /** Every active ban, for the console. */
  listBans(): Promise<readonly ModelAbuseBan[]>;
  /** Lifts one ban, by the opaque member the listing reports. */
  unban(identity: string): Promise<boolean>;
  /**
   * Bans one member immediately for `ttlMs`, regardless of strike history.
   * Returns the ban's expiry (epoch ms). The operator's instant-ban action
   * and the graduated strike path share one ban set, so `unban` lifts both.
   */
  ban(identity: string, ttlMs: number): Promise<number>;
}

interface InMemoryOptions {
  readonly maxKeys?: number;
}

/**
 * In-memory strike store: one timestamp list and one ban map.
 *
 * Each invalid attempt keeps its own instant. The count is the number of
 * instants still inside the window, so a valid request cannot reset it and an
 * old attempt leaves on its own. A ban carries the instant it lapses and is
 * swept lazily on the next read of that address. Bounded by `maxKeys` (oldest
 * evicted) so an adversarial fan-out over unique addresses cannot pin memory;
 * the ban map is bounded by the abuse itself, since each entry cost a full
 * threshold of attempts, and entries leave when their TTL lapses.
 */
export class InMemoryModelAbuseStore implements ModelAbuseStore {
  private readonly strikes = new Map<string, number[]>();
  private readonly bans = new Map<string, number>();
  private readonly maxKeys: number;

  constructor(private readonly clock: () => number = () => Date.now(), opts: InMemoryOptions = {}) {
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  private evictOldest(): void {
    if (this.strikes.size < this.maxKeys) return;
    let toEvict = this.strikes.size - this.maxKeys + 1;
    for (const key of this.strikes.keys()) {
      if (toEvict-- <= 0) break;
      this.strikes.delete(key);
    }
  }

  /** The live ban's expiry, or `undefined`; an elapsed ban is dropped. */
  private banExpiry(identity: string, now: number): number | undefined {
    const expiresAt = this.bans.get(identity);
    if (expiresAt === undefined) return undefined;
    if (expiresAt <= now) {
      this.bans.delete(identity);
      return undefined;
    }
    return expiresAt;
  }

  /**
   * Whether `identity` is banned, reading both members that can block it.
   *
   * The entry for this exact address+key, and the address-wide entry. The
   * second is what makes a ban scoped to every key from an address still
   * enforced, and what keeps a ban written before scoping existed — whose
   * member is the bare address — from silently lapsing on deploy.
   */
  private bannedNow(identity: string, now: number): boolean {
    const { ip, apiKeyId } = parseBanIdentity(identity);
    if (this.banExpiry(identity, now) !== undefined) return true;
    if (apiKeyId === null) return false;
    return this.banExpiry(addressBanIdentity(ip), now) !== undefined;
  }

  /** Drops attempts older than the window and returns the rest. */
  private liveAttempts(identity: string, now: number, windowMs: number): number[] {
    const cutoff = now - windowMs;
    const existing = this.strikes.get(identity) ?? [];
    // In-place compaction: `.filter` allocated a new array per invalid attempt.
    let write = 0;
    for (let read = 0; read < existing.length; read += 1) {
      if (existing[read]! > cutoff) existing[write++] = existing[read]!;
    }
    existing.length = write;
    if (existing.length === 0) this.strikes.delete(identity);
    else this.strikes.set(identity, existing);
    return existing;
  }

  async record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome> {
    const now = this.clock();
    const { ip, apiKeyId, valid, threshold, windowMs, banTtlMs } = attempt;
    const identity = banIdentity(ip, apiKeyId);

    if (this.bannedNow(identity, now)) return { banned: true, strikes: 0, bannedNow: false };

    if (valid) return { banned: false, strikes: 0, bannedNow: false };

    const live = this.liveAttempts(identity, now, windowMs);
    live.push(now);
    this.evictOldest();
    this.strikes.set(identity, live);
    if (live.length >= threshold) {
      // Scoped to the key that earned it. Banning the address alone would take
      // down every other caller behind the same NAT or share link, none of
      // whom made the invalid requests.
      this.bans.set(identity, now + banTtlMs);
      this.strikes.delete(identity);
      return { banned: true, strikes: live.length, bannedNow: true };
    }
    return { banned: false, strikes: live.length, bannedNow: false };
  }


  async listBans(): Promise<readonly ModelAbuseBan[]> {
    const now = this.clock();
    const bans: ModelAbuseBan[] = [];
    for (const [identity, expiresAt] of [...this.bans]) {
      if (expiresAt <= now) {
        this.bans.delete(identity);
        continue;
      }
      const { ip, apiKeyId } = parseBanIdentity(identity);
      bans.push({
        ip,
        apiKeyId,
        reason: "repeated_invalid_model_requests",
        expiresAt,
        permanent: isPermanentBan(expiresAt, now),
        identity,
      });
    }
    return bans;
  }

  async isBanned(identity: string): Promise<boolean> {
    return this.bannedNow(identity, this.clock());
  }

  async unban(identity: string): Promise<boolean> {
    return this.bans.delete(identity);
  }

  async ban(identity: string, ttlMs: number): Promise<number> {
    const expiresAt = this.clock() + Math.max(1, ttlMs);
    this.bans.set(identity, expiresAt);
    return expiresAt;
  }
}

/**
 * The one strike decision, as a static Lua script.
 *
 * `KEYS[1]` the attempt sorted set for this address+key, `KEYS[2]` the ban
 * sorted set. `ARGV`: 1 valid(`1`/`0`), 2 windowMs, 3 this caller's ban
 * member, 4 now (epoch ms), 5 threshold, 6 banTtlMs, 7 the address-wide ban
 * member.
 *
 * Returns `{banned, strikes, bannedNow}`. The ban is read first and
 * short-circuits without writing, so a banned caller cannot extend its own
 * window — and it is read for *both* members: the one naming this key, and the
 * address-wide one. The second is what keeps a ban scoped to "every key from
 * this address" enforced, and what keeps a ban written before scoping existed
 * (whose member is the bare address) from lapsing on deploy. Both reads happen
 * inside the script because the gate runs on every `/v1/*` request: two
 * `ZSCORE` calls from the caller would be two round trips per request.
 *
 * Each invalid attempt is one member scored by its instant. Members older than
 * the window are removed before the count, so a valid request does not reset
 * it and an old attempt leaves on its own. A ban is a member of the ban set
 * scored with the instant it lapses. `now` is the caller's clock rather than
 * the server's so the in-memory and Redis stores age a ban identically.
 */
const MODEL_ABUSE_SCRIPT = `
  local function liveBan(member, now)
    local score = redis.call('ZSCORE', KEYS[2], member)
    if not score then return false end
    if tonumber(score) > now then return true end
    redis.call('ZREM', KEYS[2], member)
    return false
  end
  local now = tonumber(ARGV[4])
  if liveBan(ARGV[3], now) or liveBan(ARGV[7], now) then
    return {1, 0, 0}
  end
  if ARGV[1] == '1' then
    return {0, 0, 0}
  end
  local windowMs = tonumber(ARGV[2])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
  local seq = redis.call('INCR', KEYS[1] .. ':seq')
  redis.call('ZADD', KEYS[1], now, now .. ':' .. seq)
  local count = redis.call('ZCARD', KEYS[1])
  redis.call('PEXPIRE', KEYS[1], windowMs)
  redis.call('PEXPIRE', KEYS[1] .. ':seq', windowMs)
  if count >= tonumber(ARGV[5]) then
    redis.call('ZADD', KEYS[2], now + tonumber(ARGV[6]), ARGV[3])
    redis.call('DEL', KEYS[1], KEYS[1] .. ':seq')
    return {0, count, 1}
  end
  return {0, count, 0}
`;

/**
 * The pre-parse ban check, as a static Lua script.
 *
 * Reads both members that can block a caller — this address+key, and the
 * address-wide one — and returns `1` or `0`. One script rather than two
 * `ZSCORE` calls from the caller because this runs on every `/v1/*` request,
 * where a second round trip is a second hop on the hot path. It also drops a
 * member it finds elapsed, which is what keeps the ban set from accumulating
 * dead entries no request will ever look up again.
 */
const MODEL_ABUSE_BAN_CHECK_SCRIPT = `
  local function liveBan(member, now)
    local score = redis.call('ZSCORE', KEYS[1], member)
    if not score then return false end
    if tonumber(score) > now then return true end
    redis.call('ZREM', KEYS[1], member)
    return false
  end
  local now = tonumber(ARGV[3])
  if liveBan(ARGV[1], now) or liveBan(ARGV[2], now) then
    return 1
  end
  return 0
`;

export class RedisModelAbuseStore implements ModelAbuseStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private strikeKey(identity: string): string {
    return `cartethyia:model-abuse:strike:${identity}`;
  }
  /**
   * The ban index. It is a sorted set scored with each ban's expiry instant,
   * under a name of its own: the previous permanent-ban *set* cannot be read as
   * a sorted set, and reading it anyway would raise WRONGTYPE on every check.
   * A member from before that change is therefore simply gone — the right
   * outcome, since those bans were recorded without an expiry this store cannot
   * invent.
   *
   * The members are now `address|key` composites, and a member with no key
   * blocks every key from its address — which is also how a pre-scoping member
   * reads, since those were the bare address.
   */
  private banKey(): string {
    return "cartethyia:model-abuse:bans";
  }

  async record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome> {
    const { ip, apiKeyId, valid, threshold, windowMs, banTtlMs } = attempt;
    const identity = banIdentity(ip, apiKeyId);
    const raw = await redisEvalTuple(
      this.redis,
      MODEL_ABUSE_SCRIPT,
      2,
      this.strikeKey(identity),
      this.banKey(),
      valid ? "1" : "0",
      String(Math.max(1, windowMs)),
      identity,
      String(this.clock()),
      String(threshold),
      String(Math.max(1, banTtlMs)),
      addressBanIdentity(ip),
    );
    return decodeOutcome(raw);
  }

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    const now = this.clock();
    await this.redis.zremrangebyscore(this.banKey(), "-inf", String(now));
    const entries = await this.redis.zrange(this.banKey(), "0", "-1", "WITHSCORES");
    const bans: ModelAbuseBan[] = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      const identity = entries[index];
      const score = entries[index + 1];
      if (identity === undefined || score === undefined) break;
      const expiresAt = Number(score);
      if (!Number.isFinite(expiresAt)) continue;
      const { ip, apiKeyId } = parseBanIdentity(identity);
      bans.push({
        ip,
        apiKeyId,
        reason: "repeated_invalid_model_requests",
        expiresAt,
        permanent: isPermanentBan(expiresAt, now),
        identity,
      });
    }
    return bans;
  }

  async isBanned(identity: string): Promise<boolean> {
    const { ip, apiKeyId } = parseBanIdentity(identity);
    const value = await redisEvalNumber(
      this.redis,
      MODEL_ABUSE_BAN_CHECK_SCRIPT,
      1,
      this.banKey(),
      identity,
      // A ban scoped to no key is its own address-wide member, so the second
      // read is the same member — harmless, and it keeps the script one shape.
      apiKeyId === null ? identity : addressBanIdentity(ip),
      String(this.clock()),
    );
    return value === 1;
  }

  async unban(identity: string): Promise<boolean> {
    const removed = await this.redis.zrem(this.banKey(), identity);
    return Number(removed) > 0;
  }

  async ban(identity: string, ttlMs: number): Promise<number> {
    const expiresAt = this.clock() + Math.max(1, ttlMs);
    await this.redis.zadd(this.banKey(), String(expiresAt), identity);
    return expiresAt;
  }
}

export interface ModelStrikeOptions {
  /** Invalid-model attempts inside the window that trigger a ban. Default 10. */
  readonly threshold?: number;
  /** Sliding window (ms) that keeps an invalid attempt countable. Default 30 minutes. */
  readonly windowMs?: number;
  /** How long (ms) a graduated ban lasts before it lapses. Default 6 hours. */
  readonly banTtlMs?: number;
  /**
   * The longest ban this service will record, however long a caller asks for.
   * Default one week. The "Permanent" choice is not exempt: it is a very long
   * TTL, not an unbounded one, and this is the bound that keeps a typo in a
   * duration from parking a caller for a decade.
   */
  readonly maxBanTtlMs?: number;
}

/**
 * Graduated model-abuse strikes over a store.
 *
 * `noteInvalid` records one invalid attempt in the sliding window. `noteValid`
 * does not reset that window. `listBans`/`unban` are the console's escape hatch.
 */
export class ModelStrikeService {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly _banTtlMs: number;
  private readonly _maxBanTtlMs: number;

  constructor(private readonly store: ModelAbuseStore, opts: ModelStrikeOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? 10);
    this.windowMs = Math.max(1, opts.windowMs ?? 30 * 60_000);
    this._banTtlMs = Math.max(1, opts.banTtlMs ?? 6 * 60 * 60_000);
    // The operator-facing ceiling defaults to a week — the same upper bound the
    // deployment env var accepts — so a request cannot ask for a ban longer
    // than the longest one an operator can configure by hand.
    this._maxBanTtlMs = Math.max(
      this._banTtlMs,
      Math.max(1, opts.maxBanTtlMs ?? 7 * 24 * 60 * 60_000),
    );
  }

  /** The ban threshold, for an operator-facing warning message. */
  get limit(): number {
    return this.threshold;
  }

  get banTtlMs(): number {
    return this._banTtlMs;
  }

  /** The longest ban this service will record, however long one is asked for. */
  get maxBanTtlMs(): number {
    return this._maxBanTtlMs;
  }

  /**
   * Read-only ban lookup for the pre-parse gate. Throws only on store outage.
   *
   * `apiKeyId` decides how narrow the answer is. Absent (an unauthenticated
   * attempt, or a composition that does not carry the key) asks the blunt
   * question — is this address banned outright — which is also the only
   * question a caller with no key can be asked.
   */
  async check(input: { readonly ip: string; readonly apiKeyId?: string | null }): Promise<boolean> {
    return this.store.isBanned(banIdentity(input.ip, input.apiKeyId));
  }

  /** Records one invalid-model attempt and returns the escalation decision. */
  async noteInvalid(input: {
    readonly ip: string;
    readonly apiKeyId?: string | null;
  }): Promise<ModelAbuseOutcome> {
    return this.store.record({
      ip: input.ip,
      ...(input.apiKeyId === undefined ? {} : { apiKeyId: input.apiKeyId }),
      valid: false,
      threshold: this.threshold,
      windowMs: this.windowMs,
      banTtlMs: this.banTtlMs,
    });
  }

  /** A valid model request does not reset the invalid-attempt window. */
  async noteValid(_input: { readonly ip: string }): Promise<void> {}

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    return this.store.listBans();
  }

  async unban(identity: string): Promise<boolean> {
    return this.store.unban(identity);
  }

  /**
   * Operator instant-ban: one caller for one chosen duration, no strike
   * history needed.
   *
   * `apiKeyId: null` is the deliberate blunt instrument — it bans every key
   * used from that address, which is what an operator wants when the address
   * is the problem rather than the credential. `addressOnly` is therefore not
   * a fallback for a missing key; it is a choice the console makes visible.
   *
   * `ttlMs` is clamped to `maxBanTtlMs` here rather than only at the route:
   * the service is the last layer before the store, and a bound that only
   * exists in HTTP is one a caller in-process can walk past. The one value
   * that escapes the clamp is {@link PERMANENT_BAN_TTL_MS} — it *is* the
   * clamp's own ceiling in the other direction, so a request asking for it is
   * asking for "permanent" and gets exactly that, no more.
   */
  async ban(input: {
    readonly ip: string;
    readonly apiKeyId?: string | null;
    readonly ttlMs?: number;
    readonly addressOnly?: boolean;
  }): Promise<ModelAbuseBan> {
    const identity = input.addressOnly
      ? addressBanIdentity(input.ip)
      : banIdentity(input.ip, input.apiKeyId);
    const requested = input.ttlMs ?? this.banTtlMs;
    const ttlMs =
      requested >= PERMANENT_BAN_TTL_MS
        ? PERMANENT_BAN_TTL_MS
        : Math.min(Math.max(1, Math.floor(requested)), this.maxBanTtlMs);
    const expiresAt = await this.store.ban(identity, ttlMs);
    const { ip, apiKeyId } = parseBanIdentity(identity);
    return {
      ip,
      apiKeyId,
      reason: "repeated_invalid_model_requests",
      expiresAt,
      permanent: isPermanentBan(expiresAt, Date.now()),
      identity,
    };
  }
}

/**
 * The typed rejection a banned caller receives. 403 with its own code so the
 * console and the client can tell an abuse ban from a per-request rejection.
 * The message names the reason without the ban duration.
 */
export function modelAbuseBannedError(): GatewayError {
  // English, because this is a client-facing wire message: the gateway's other
  // public errors are English, and a client that pattern-matches on the text
  // (or an operator reading a foreign-language response) cannot act on one that
  // is not. It also names the scope — the ban is this address *with this key*,
  // not the address outright — so a caller behind a shared address knows a
  // different key from the same address may still work.
  return new GatewayError(
    "model_abuse_banned",
    403,
    "This address is temporarily banned for this API key after too many requests for models this key cannot use. Wait for the ban to lift, then list models to see which ones this key may call.",
  );
}

/**
 * The 404 a rejected model returns, carrying the escalating warning. The
 * message names the strike count without naming how long a ban lasts.
 */
export function modelWarningMessage(
  model: string,
  outcome: ModelAbuseOutcome,
  limit: number,
): string {
  const remaining = Math.max(0, limit - outcome.strikes);
  // "this IP" is now a lie when the ban is scoped to the key: the escalation
  // blocks this address *with this key*, and a caller behind a shared address
  // is entitled to know that switching keys will not help but a different
  // caller on the same address is not affected.
  const tail =
    remaining === 0
      ? "The next invalid request will temporarily ban this IP for this API key. Use /v1/models to see allowed models."
      : remaining === 1
        ? "1 more invalid request will temporarily ban this IP for this API key. Use /v1/models to see allowed models."
        : `${remaining} more invalid requests will temporarily ban this IP for this API key. Use /v1/models to see allowed models.`;
  return `Model '${model}' is not available to this API key. Warning ${outcome.strikes}/${limit} — ${tail}`;
}
