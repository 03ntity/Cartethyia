import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Stack } from "../../../components/ui/stack";
import type {
  HealthCheckResult,
  NetworkPoolResponse,
  PoolProviderProbeResult,
} from "../../../data/contracts";
import {
  useCreateNetworkPoolBatch,
  useHealthCheckNetworkPool,
  useProbeAdHocProviderBatch,
  useProbeNetworkPoolBatch,
  useUpdateNetworkPool,
} from "../../../hooks/network";
import {
  SCHEME_CHIPS,
  type SchemeChip,
  applySchemeChip,
  detectProxyKind,
  parseQuotaGb,
  splitQuotaAcrossFamily,
} from "../proxy-endpoint";
import { MAX_BATCH_PROBE_TARGETS } from "../proxy-metrics";
import { formatBytes } from "../../../lib/format/numbers";
import { toast } from "../../../lib/toast";
import { getErrorMessage } from "../../../data/api";

// The batch create is a single request now; this constant is kept only as a
// documentation of the historical per-row concurrency bound.

/** The provider the OpenCode payload asks. */
export const PROBE_PROVIDER_ID = "opencode";

const GIB = 1024 ** 3;

export function PoolEditForm({
  pool,
  onClose,
  actionsRef,
}: {
  readonly pool: NetworkPoolResponse;
  readonly onClose: () => void;
  readonly actionsRef?: (actions: ReactNode) => void;
}): ReactNode {
  const updatePool = useUpdateNetworkPool();
  const adhocProviderProbe = useProbeAdHocProviderBatch();
  const healthCheck = useHealthCheckNetworkPool();
  const [label, setLabel] = useState(pool.label ?? "");
  const [family, setFamily] = useState(pool.family ?? "");
  const [endpoint, setEndpoint] = useState(pool.endpoint ?? "");
  const [cap, setCap] = useState(String(pool.maxInflight ?? 10));
  const [weight, setWeight] = useState(String(pool.weight ?? 100));
  // Quota is entered in GB because that is how providers sell it; it is stored
  // in bytes so the usage bar can compare without a lossy round-trip.
  const [quotaGb, setQuotaGb] = useState(
    pool.quotaBytes ? String(Math.round((pool.quotaBytes / GIB) * 1000) / 1000) : "",
  );
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  /**
   * Tests the endpoint **in the form**, not the one stored on the row.
   *
   * `healthCheck(pool.id)` dialed the saved endpoint, so an operator who pasted
   * a new proxy and pressed Test was told about the old one — and the answer
   * looked authoritative. The provider probe has an ad-hoc form for exactly
   * this: it builds the pool from the request body, so the verdict describes
   * what the operator is about to save.
   *
   * A stored credential cannot ride along — the ad-hoc form never carries one,
   * by design, because the console never sends a secret back to the browser.
   * For an unchanged endpoint on a credentialed pool the saved row is the only
   * thing that can authenticate, so that case keeps using the health check.
   */
  const endpointUnchanged = endpoint.trim() === pool.endpoint;
  const runAdhocTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (endpointUnchanged) {
        const health = await healthCheck.mutateAsync(pool.id);
        const ok = health.status === "healthy" || health.status === "reachable";
        setTestResult({
          ok,
          message:
            health.status === "healthy"
              ? `Connected in ${health.latencyMs ?? 0}ms`
              : health.errorMessage ?? "Connection failed",
        });
        return;
      }
      const targets = [
        {
          kind: pool.kind,
          endpoint: endpoint.trim(),
          ...(pool.family === null || pool.family === undefined ? {} : { family: pool.family }),
        },
      ];
      const [batch] = await adhocProviderProbe.mutateAsync({
        providerId: PROBE_PROVIDER_ID,
        targets: targets as never,
      });
      const result = batch?.result;
      if (!result) {
        setTestResult({ ok: false, message: "Probe returned no result" });
        return;
      }
      const ok = result.status === "allowed" || result.status === "throttled";
      setTestResult({
        ok,
        message:
          result.reason ??
          (result.status === "allowed"
            ? `Reachable${result.latencyMs === undefined ? "" : ` in ${result.latencyMs}ms`}`
            : result.status === "throttled"
              ? "Reachable; rate limit spent"
              : "Probe could not complete"),
      });
    } catch (err) {
      setTestResult({ ok: false, message: getErrorMessage(err, "Connection failed") });
    } finally {
      setTesting(false);
    }
  };

  const quotaValue = parseQuotaGb(quotaGb);

  const save = async () => {
    await updatePool.mutateAsync({
      poolId: pool.id,
      request: {
        ...(label.trim() !== pool.label ? { label: label.trim() || undefined } : {}),
        // An emptied box clears the tag, so compare against the raw stored
        // value rather than a trimmed one.
        ...(family.trim() !== (pool.family ?? "") ? { family: family.trim() || null } : {}),
        ...(endpoint.trim() !== pool.endpoint && endpoint.trim() !== ""
          ? { endpoint: endpoint.trim() }
          : {}),
        ...(Number(cap) !== pool.maxInflight ? { maxInflight: Number(cap) } : {}),
        ...(Number(weight) !== pool.weight ? { weight: Number(weight) } : {}),
        ...(quotaValue !== (pool.quotaBytes ?? null) ? { quotaBytes: quotaValue } : {}),
      },
    });
    toast.success("Proxy updated");
    onClose();
  };

  useEffect(() => {
    actionsRef?.(
      <>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={updatePool.isPending || !endpoint.trim()} onClick={() => void save()}>Save</Button>
      </>
    );
  });
  return (
    <Stack gap="12px">
      <div>
        <Input
          label="Name"
          value={label}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
        />
      </div>
      <div>
        <Input
          label="Family"
          value={family}
          placeholder="e.g. residential-id"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFamily(e.target.value)}
        />
      </div>
      <div>
        <Input
          label="Endpoint"
          value={endpoint}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndpoint(e.target.value)}
          className="font-mono tabular-nums"
        />
      </div>
      <div className="grid grid-cols-2 gap-5">
        <div>
          <Input
            label="Max concurrent"
            type="number"
            min={1}
            value={cap}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCap(e.target.value)}
          />
        </div>
        <div>
          <Input
            label="Weight"
            type="number"
            min={1}
            value={weight}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWeight(e.target.value)}
          />
        </div>
      </div>
      <div>
        <Input
          label="Bandwidth quota (GB, blank = unmetered)"
          type="number"
          min={0.001}
          step="0.1"
          value={quotaGb}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuotaGb(e.target.value)}
        />
        <div className="text-micro text-text-tertiary mt-2">
          {quotaValue === null
            ? "No quota — the bar shows a running total only."
            : `Bar turns orange at 80% and red once ${formatBytes(quotaValue)} is exceeded.`}
        </div>
      </div>
      {testResult && (
        <div
          // The connection outcome is read from the test result, so its fill
          // and ink are chosen at render time.
          className={`rounded-inset px-6 py-4 text-badge font-semibold ${testResult.ok ? "bg-green-soft text-green" : "bg-red-soft text-red"}`}
        >
          {testResult.message}
        </div>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={testing}
          icon={testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />}
          onClick={() => void runAdhocTest()}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
      </div>
    </Stack>
  );
}
/**
 * The scheme chips row, extracted so it can be rendered directly with props.
 *
 * Rendering the whole batch form to test a chip means driving a textarea's
 * value through happy-dom, and React's synthetic `onChange` does not fire there
 * — so the chip's behaviour (which scheme is pressed, what preview appears) is
 * asserted against this component with explicit props instead.
 *
 * `endpoint` is the first non-empty paste line, or undefined on an empty paste.
 * The chips are disabled until it exists, and an explicit scheme on that line
 * always wins inside `applySchemeChip`, so a chip never masks a host the
 * operator already wrote.
 */
export function SchemeChipRow({
  endpoint,
  chip,
  onChipChange,
}: {
  readonly endpoint: string | undefined;
  readonly chip: SchemeChip | null;
  readonly onChipChange: (chip: SchemeChip | null) => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Scheme for the first endpoint">
      <span className="text-badge text-text-secondary">Scheme</span>
      {SCHEME_CHIPS.map((scheme) => {
        const active = chip === scheme;
        return (
          <Button
            key={scheme}
            type="button"
            variant={active ? "primary" : "secondary"}
            size="sm"
            disabled={endpoint === undefined}
            aria-pressed={active}
            data-scheme={scheme}
            onClick={() => onChipChange(active ? null : scheme)}
            className="font-mono"
          >
            {scheme}://
          </Button>
        );
      })}
      {chip !== null && (
        <span className="text-badge text-text-tertiary">
          → {applySchemeChip(endpoint ?? "", chip)}
        </span>
      )}
    </div>
  );
}
export function ProxyBulkForm({
  onClose,
  actionsRef,
  onProbeResult,
  onHealthResult,
}: {
  readonly onClose: () => void;
  readonly actionsRef?: (actions: ReactNode) => void;
  /** Hands a provider-probe verdict to the page once the pool row exists. */
  readonly onProbeResult?: (poolId: string, result: PoolProviderProbeResult) => void;
  /** Hands the URL test's verdict along with it, so both survive the save. */
  readonly onHealthResult?: (poolId: string, result: HealthCheckResult) => void;
}): ReactNode {
  const createPoolBatch = useCreateNetworkPoolBatch();
  const probeBatch = useProbeNetworkPoolBatch();
  const probeProviderBatch = useProbeAdHocProviderBatch();
  const [text, setText] = useState("");
  const [family, setFamily] = useState("");
  const [quotaGb, setQuotaGb] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [log] = useState<string[]>([]);
  // Keyed by endpoint so a row can inherit the verdict once the pool exists.
  const [probeByEndpoint, setProbeByEndpoint] = useState<Record<string, PoolProviderProbeResult>>({});
  // The URL test's verdict, kept beside it. The two answer different questions
  // — "does this tunnel carry traffic" and "will this provider serve it" — and
  // an operator who ran both expects the saved row to show both, not just the
  // second one.
  const [healthByEndpoint, setHealthByEndpoint] = useState<Record<string, HealthCheckResult>>({});
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Scheme is inferred from each line's own prefix; there is no separate
  // scheme UI to keep in sync with the paste.
  const overCap = lines.length > MAX_BATCH_PROBE_TARGETS;
  const quotaBytes = parseQuotaGb(quotaGb);
  const targets = useMemo(
    () => lines.map((line) => ({ kind: detectProxyKind(line), endpoint: line })),
    [lines],
  );
  // Live per-endpoint progress for both URL and OpenCode tests: each row
  // flips to its verdict the moment that single probe settles, instead of all
  // rows appearing together after the whole batch finishes.
  const [progress, setProgress] = useState<Array<{ endpoint: string; line: string }>>([]);
  const [summary, setSummary] = useState("");
  const patchProgress = (endpoint: string, line: string) =>
    setProgress((prev) => prev.map((row) => (row.endpoint === endpoint ? { ...row, line } : row)));
  const PROBE_CONCURRENCY = 5;

  const handlePaste = async () => {
    try {
      const v = await navigator.clipboard.readText();
      if (v) setText((p) => (p ? `${p}\n${v}` : v));
    } catch {
      toast.error("Paste failed", "Clipboard access denied");
    }
  };

  /**
   * Probes every pasted endpoint live, one request per endpoint, updating each
   * row the moment its own probe settles.
   *
   * Reports the egress address alongside latency, because the address is what
   * the table shows after the rows are saved — an operator testing before
   * adding wants to see the same two facts the table will carry.
   */
  const runTestUrl = async () => {
    if (targets.length === 0) return;
    setProgress(targets.map((target) => ({ endpoint: target.endpoint, line: `Testing ${target.endpoint}…` })));
    let ok = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const index = cursor++;
        const target = targets[index]!;
        try {
          const [entry] = await probeBatch.mutateAsync([target]);
          if (!entry) {
            patchProgress(target.endpoint, `FAIL ${target.endpoint} · probe returned no result`);
            continue;
          }
          const result = entry.result;
          const reachable = result.status === "healthy" || result.status === "reachable";
          if (reachable) ok++;
          const latency = result.latencyMs === undefined ? "" : ` · ${result.latencyMs}ms`;
          const egress = result.egressIp ? ` · ${result.egressIp}` : "";
          const detail = reachable ? "" : ` · ${result.errorMessage ?? result.status}`;
          patchProgress(target.endpoint, `${reachable ? "OK  " : "FAIL"} ${target.endpoint}${latency}${egress}${detail}`);
          setHealthByEndpoint((prev) => ({ ...prev, [target.endpoint]: result }));
        } catch (err) {
          patchProgress(target.endpoint, `FAIL ${target.endpoint} · ${getErrorMessage(err, "probe failed")}`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, () => worker()),
    );
    setSummary(`${ok}/${targets.length} reachable`);
    if (ok === targets.length) toast.success(`All ${targets.length} proxies reachable`);
    else if (ok === 0) toast.error("No proxy reachable");
    else toast.error(`${targets.length - ok} of ${targets.length} proxies failed`);
  };

  /**
   * Asks OpenCode, through each pasted endpoint, whether it will serve us —
   * live, one endpoint at a time.
   *
   * Separate from the URL test rather than a mode of it: the two answer
   * different questions, and an operator reading the log needs to know which
   * one produced a line. A blocked address still answers the URL test, so the
   * two results are not interchangeable.
   */
  const runTestOpencode = async () => {
    if (targets.length === 0) return;
    setProgress(targets.map((target) => ({ endpoint: target.endpoint, line: `Testing ${target.endpoint} vs OpenCode…` })));
    let allowed = 0;
    let blocked = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const index = cursor++;
        const target = targets[index]!;
        try {
          const [entry] = await probeProviderBatch.mutateAsync({
            providerId: PROBE_PROVIDER_ID,
            targets: [target],
          });
          if (!entry) {
            patchProgress(target.endpoint, `FAIL ${target.endpoint} · probe returned no result`);
            continue;
          }
          const { status, latencyMs, reason } = entry.result;
          if (status === "allowed") allowed++;
          else if (status === "blocked") blocked++;
          const latency = latencyMs === undefined ? "" : ` · ${latencyMs}ms`;
          const detail = reason === undefined ? "" : ` · ${reason}`;
          patchProgress(
            target.endpoint,
            `${status === "allowed" ? "OK  " : status === "blocked" ? "BLOCK" : "FAIL"} ${target.endpoint}${latency}${detail}`,
          );
          setProbeByEndpoint((prev) => ({ ...prev, [target.endpoint]: entry.result }));
        } catch (err) {
          patchProgress(target.endpoint, `FAIL ${target.endpoint} · ${getErrorMessage(err, "probe failed")}`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, () => worker()),
    );
    setSummary(`${allowed}/${targets.length} allowed · ${blocked} blocked`);
    if (blocked === 0 && allowed === targets.length) {
      toast.success(`OpenCode accepted all ${targets.length} proxies`);
    } else {
      toast.error(`OpenCode: ${allowed} allowed · ${blocked} blocked`);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lines.length === 0) return;
    setError(null);
    setBatchSubmitting(true);
    try {
      // A shared pool, not a per-proxy allowance: every row that names the same
      // family draws from the one quota figure, so the operator's 100 GB means
      // 100 GB for that family — 5 endpoints share it at 20 GB each, not 100 GB
      // apiece. Rows with no family are outside any pool and take no quota.
      const perRowQuota =
        quotaBytes === null
          ? new Map<number, number>()
          : splitQuotaAcrossFamily(quotaBytes, family, lines.length);
      const requests = lines.map((line, index) => ({
        kind: detectProxyKind(line),
        endpoint: line,
        ...(perRowQuota.has(index) ? { quotaBytes: perRowQuota.get(index) } : {}),
        ...(family.trim() !== "" ? { family: family.trim() } : {}),
      }));
      // One request creates the whole paste; the backend inserts all rows in a
      // single statement. A long paste used to be one round trip per proxy.
      const { created, failed } = await createPoolBatch.mutateAsync(requests);
      // Carry both verdicts the operator already paid for onto the rows that
      // now exist, in paste order, so the table shows them without a re-test.
      created.forEach((pool, index) => {
        const line = lines[index] ?? "";
        const probed = probeByEndpoint[line];
        const health = healthByEndpoint[line];
        if (health !== undefined) onHealthResult?.(pool.id, health);
        if (probed !== undefined) onProbeResult?.(pool.id, probed);
      });
      if (failed > 0) setError(`${failed} of ${lines.length} proxies failed validation`);
      if (created.length > 0) {
        toast.success(
          `Added ${created.length} proxy pool(s)`,
          failed ? `${failed} failed` : undefined,
        );
        setText("");
        onClose();
      }
    } finally {
      setBatchSubmitting(false);
    }
  };

  useEffect(() => {
    actionsRef?.(
      <>
        <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="add-proxy-form" disabled={batchSubmitting || lines.length === 0}>
          {batchSubmitting ? "Adding…" : `Add ${lines.length} Prox${lines.length === 1 ? "y" : "ies"}`}
        </Button>
      </>
    );
  }, [actionsRef, batchSubmitting, lines.length, onClose]);
  return (
    <form id="add-proxy-form" onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="proxy-endpoints" className="text-caption font-semibold text-text-primary">
          Proxy endpoints
        </label>
        <Button variant="secondary" size="sm" type="button" onClick={handlePaste}>
          Paste
        </Button>
      </div>
      <textarea
        id="proxy-endpoints"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"http://proxy.example:8080\nhttps://proxy.example:8443\nsocks5://proxy.example:1080"}
        rows={5}
        aria-describedby="proxy-format-hint proxy-line-count"
        aria-invalid={Boolean(error)}
        className="w-full min-h-32 max-h-64 resize-y overflow-y-auto rounded-control border border-inner-border bg-surface-1 p-3 font-mono text-caption text-text-primary outline-none transition-[border-color,box-shadow] duration-(--dur-micro) ease-spring focus:border-accent focus:shadow-focus"
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p id="proxy-format-hint" className="m-0 text-badge leading-normal text-text-secondary">
          HTTP, HTTPS, or SOCKS5 | one per line | authentication optional
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <span
            id="proxy-line-count"
            role="status"
            aria-live="polite"
            className={`text-badge ${overCap ? "text-red" : "text-text-tertiary"}`}
          >
            {lines.length === 1 ? "1 proxy detected" : `${lines.length} proxies detected`}
            {overCap ? ` · max ${MAX_BATCH_PROBE_TARGETS} per test` : ""}
          </span>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void runTestUrl()}
            disabled={probeBatch.isPending || probeProviderBatch.isPending || lines.length === 0 || overCap}
          >
            {probeBatch.isPending ? "Testing…" : "Test URL"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void runTestOpencode()}
            disabled={probeBatch.isPending || probeProviderBatch.isPending || lines.length === 0 || overCap}
          >
            {probeProviderBatch.isPending ? "Testing…" : "Test OpenCode"}
          </Button>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="max-h-28 overflow-y-auto rounded-inset bg-red-soft px-4 py-3 text-badge text-red whitespace-pre-wrap break-words"
        >
          {error}
        </div>
      )}
      {(log.length > 0 || progress.length > 0 || summary !== "") && (
        <div
          role="log"
          aria-label="Proxy test results"
          aria-live="polite"
          className="scroll-region max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-inset border border-inner-border bg-surface-1 px-3 py-2 font-mono text-badge leading-[1.5] text-text-secondary"
        >
          {summary !== "" ? summary : ""}
          {(summary !== "" && (log.length > 0 || progress.length > 0) ? "\n" : "") +
            (log.length > 0 ? log.join("\n") : "")}
          {(summary !== "" || log.length > 0) && progress.length > 0 ? "\n" : ""}
          {progress.map((row) => row.line).join("\n")}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          id="proxy-family"
          label="Family"
          hint="Optional"
          value={family}
          placeholder="e.g. residential-id"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFamily(e.target.value)}
          className="w-full"
        />
        <Input
          id="proxy-quota"
          label="Bandwidth quota (GB)"
          hint="Optional"
          type="number"
          min={0.001}
          step="0.1"
          value={quotaGb}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuotaGb(e.target.value)}
          className="w-full"
        />
      </div>
    </form>
  );
}
