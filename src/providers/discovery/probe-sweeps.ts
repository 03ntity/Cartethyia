/**
 * Batched provider-wide and account-wide probe sweeps.
 *
 * Both sweeps run a sliding worker pool over a `probeOne` callback supplied by
 * the runner's facade, so a subclass override of `probeModel` stays the single
 * dispatch point. The first probe runs sequentially to warm OAuth token caches
 * and connection pools before concurrent workers start.
 */
import { and, eq, inArray } from "drizzle-orm";
import { globalOrOwnedBy } from "../../persistence/tenant-scope";
import { providerAccounts } from "../../persistence/schema";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type {
  ProbeAllAccountsResult,
  ProbeAllModelsResult,
  ProbeModelRequest,
  ProbeModelResult,
} from "./discovery-types";

/** Max models probed concurrently per batch (outside the sequential warm-up). */
const PROBE_CONCURRENCY = 5;
/** Max accounts probed concurrently; batches wait before starting the next ten. */
const PROBE_ACCOUNT_CONCURRENCY = 10;

/**
 * Batched provider-wide probe: the first request runs sequentially (it warms
 * OAuth token caches and connection pools for the provider), the rest run
 * through a sliding worker pool bounded to `PROBE_CONCURRENCY`. Each request
 * carries its model route and service kind so native services never fall
 * through to an LLM probe.
 *
 * `mode` flows through every request, so "Test all models" (D43) can use
 * the cheap `fast` path end to end.
 *
 * Sliding window beats barrel-batching here: the historical pattern waited
 * for the slowest probe in each group of `N` before starting the next group,
 * so one slow route stalled nine others. With the worker loop, a worker
 * picks up the next request as soon as its current one settles, which keeps
 * the full window of `PROBE_CONCURRENCY` in flight across the whole batch.
 *
 * `probeOne` is the facade's `probeModel` — passed as a callback so a
 * subclass override stays the single dispatch point.
 */
export async function probeAllModels(
  providerId: string,
  requests: readonly ProbeModelRequest[],
  probeOne: (request: ProbeModelRequest) => Promise<ProbeModelResult>,
): Promise<ProbeAllModelsResult> {
  const [firstRequest, ...restRequests] = requests;
  if (firstRequest === undefined) return { providerId, results: [] };

  // Position the warm-up at index 0 and the rest at their original indices
  // so a caller inspecting `results` sees them in the same order they were
  // requested. Pre-sized `Array` means workers assign by index rather than
  // racing to `push`.
  const results: ProbeAllModelsResult["results"][number][] = new Array(requests.length);

  const runOne = async (probeRequest: ProbeModelRequest, slot: number): Promise<void> => {
    const outcome = await probeOne(probeRequest);
    results[slot] = {
      modelId: probeRequest.modelId,
      ok: outcome.ok,
      latencyMs: outcome.latencyMs,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  };

  // Warm-up stays sequential: it primes OAuth token caches and connection
  // pools so the parallel workers do not each pay the first-call tax.
  await runOne(firstRequest, 0);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= restRequests.length) return;
      const request = restRequests[index]!;
      // Swallow per-probe errors to the array shape: `probeModel` is
      // supposed to return an `outcome` object even on failure, but a
      // throw here (unexpected shape, aborted socket) must not fail the
      // whole batch — the operator still needs to see which models passed.
      try {
        await runOne(request, index + 1);
      } catch (error) {
        results[index + 1] = {
          modelId: request.modelId,
          ok: false,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  const workerCount = Math.min(PROBE_CONCURRENCY, restRequests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Drop any gaps left by a `requests.length` of 1 (no rest) or an array
  // that was somehow sparser than planned — defensive, not expected.
  return { providerId, results: results.filter((entry) => entry !== undefined) };
}

/**
 * Batched account-wide probe: every account of the provider (or the
 * `request.accountIds` selection) gets the same probe request.
 *
 * `probeOne` is the facade's `probeModel` — passed as a callback so a
 * subclass override stays the single dispatch point.
 */
export async function probeAllAccounts(
  db: CartethyiaDatabase,
  tenantId: string,
  providerId: string,
  request: ProbeModelRequest,
  probeOne: (request: ProbeModelRequest) => Promise<ProbeModelResult>,
): Promise<ProbeAllAccountsResult> {
  const accounts = await db
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.providerId, providerId),
        globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        // `accountIds` absent means every account; when present (even
        // empty) only those ids are probed — the dashboard's "Test 407"
        // sends the selection and falls back to all when nothing is
        // selected.
        ...(request.accountIds !== undefined
          ? [inArray(providerAccounts.id, request.accountIds)]
          : []),
      ),
    );
  // Sliding worker pool: workers claim the next account as soon as their
  // current probe settles, so one slow account cannot stall the rest of the
  // window the way `Promise.all` on fixed-size batches did. Order of
  // completion is irrelevant to the caller (each result carries its own
  // `accountId`), but we still assign by slot to keep the output stable
  // for golden-file tests and operator audit replay.
  //
  // Fault tolerance: the old `Promise.all` meant a single thrown probe
  // aborted the entire batch and the operator lost the status of every
  // other account they clicked "test all" on. Catching per-account turns a
  // thrown probe into a failed result for that account only — matching the
  // dashboard's existing per-account expectation.
  const results: ProbeAllAccountsResult["results"][number][] = new Array(accounts.length);
  if (accounts.length === 0) return { providerId, modelId: request.modelId, results: [] };

  const runOne = async (account: { id: string }, slot: number): Promise<void> => {
    try {
      const result = await probeOne({
        ...request,
        accountId: account.id,
      });
      // No health write here: a probe that genuinely fails already reports
      // through `recordAccountFailure`, which classifies the real status;
      // matching answer text is not a health signal.
      results[slot] = { ...result, accountId: account.id };
    } catch (error) {
      results[slot] = {
        ok: false,
        latencyMs: 0,
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      } as ProbeAllAccountsResult["results"][number];
    }
  };

  // As in probeAllModels, the first probe primes OAuth token caches and
  // connection pools before concurrent workers start. Ten simultaneous cold
  // refreshes could otherwise trip provider rate limits and mark healthy
  // accounts as broken during a "test all" run.
  await runOne(accounts[0]!, 0);
  const restAccounts = accounts.slice(1);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= restAccounts.length) return;
      await runOne(restAccounts[index]!, index + 1);
    }
  };
  const workerCount = Math.min(PROBE_ACCOUNT_CONCURRENCY, restAccounts.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { providerId, modelId: request.modelId, results };
}
