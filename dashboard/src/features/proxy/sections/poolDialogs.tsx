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
  useCreateNetworkPool,
  useHealthCheckNetworkPool,
  useProbeAdHocProviderBatch,
  useProbeNetworkPoolBatch,
  useUpdateNetworkPool,
} from "../../../hooks/network";
import {
  SCHEME_CHIPS,
  type SchemeChip,
  applySchemeChip,
  chipTargetLine,
  detectProxyKind,
  parseQuotaGb,
  splitQuotaAcrossFamily,
} from "../proxy-endpoint";
import { MAX_BATCH_PROBE_TARGETS } from "../proxy-metrics";
import { formatBytes } from "../../../lib/format/numbers";
import { toast } from "../../../lib/toast";
import { getErrorMessage } from "../../../data/api";

const BULK_POOL_CREATE_CONCURRENCY = 4;

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
  const createPool = useCreateNetworkPool();
  const probeBatch = useProbeNetworkPoolBatch();
  const probeProviderBatch = useProbeAdHocProviderBatch();
  const [text, setText] = useState("");
  const [family, setFamily] = useState("");
  const [quotaGb, setQuotaGb] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  // Keyed by endpoint so a row can inherit the verdict once the pool exists.
  const [probeByEndpoint, setProbeByEndpoint] = useState<Record<string, PoolProviderProbeResult>>({});
  // The URL test's verdict, kept beside it. The two answer different questions
  // — "does this tunnel carry traffic" and "will this provider serve it" — and
  // an operator who ran both expects the saved row to show both, not just the
  // second one.
  const [healthByEndpoint, setHealthByEndpoint] = useState<Record<string, HealthCheckResult>>({});
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  // Scheme chip applies to the first non-empty line only, exactly as the
  // operator reads the paste: one prefix choice for the batch.
  const [chip, setChip] = useState<SchemeChip | null>(null);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // The chip prefixes the first line; an explicit scheme on that line always
  // wins, so a chip never masks what the operator already wrote.
  const firstLine = chipTargetLine(lines);
  const chippedLines = useMemo(() => {
    if (chip === null || firstLine === undefined) return lines;
    return lines.map((line, index) => (line === firstLine && index === 0 ? applySchemeChip(line, chip) : line));
  }, [lines, chip, firstLine]);
  const overCap = lines.length > MAX_BATCH_PROBE_TARGETS;
  const quotaBytes = parseQuotaGb(quotaGb);
  const targets = useMemo(
    () => chippedLines.map((line) => ({ kind: detectProxyKind(line), endpoint: line })),
    [chippedLines],
  );

  const handlePaste = async () => {
    try {
      const v = await navigator.clipboard.readText();
      if (v) setText((p) => (p ? `${p}\n${v}` : v));
    } catch {
      toast.error("Paste failed", "Clipboard access denied");
    }
  };

  /**
   * Probes every pasted endpoint in one batched request.
   *
   * Reports the egress address alongside latency, because the address is what
   * the table shows after the rows are saved — an operator testing before
   * adding wants to see the same two facts the table will carry.
   */
  const runTestUrl = async () => {
    if (targets.length === 0) return;
    setLog([`Testing ${targets.length} proxy target(s)…`]);
    try {
      const results = await probeBatch.mutateAsync(targets);
      const rows = results.map((entry) => {
        const ok = entry.result.status === "healthy" || entry.result.status === "reachable";
        const latency = entry.result.latencyMs === undefined ? "" : ` · ${entry.result.latencyMs}ms`;
        const egress = entry.result.egressIp ? ` · ${entry.result.egressIp}` : "";
        const detail = ok ? "" : ` · ${entry.result.errorMessage ?? entry.result.status}`;
        return `${ok ? "OK  " : "FAIL"} ${entry.endpoint}${latency}${egress}${detail}`;
      });
      const okCount = results.filter(
        (r) => r.result.status === "healthy" || r.result.status === "reachable",
      ).length;
      setHealthByEndpoint((prev) => {
        const next = { ...prev };
        for (const entry of results) next[entry.endpoint] = entry.result;
        return next;
      });
      setLog([`${okCount}/${results.length} reachable`, ...rows]);
      if (okCount === results.length) toast.success(`All ${results.length} proxies reachable`);
      else toast.error(`${results.length - okCount} of ${results.length} proxies failed`);
    } catch (err) {
      setLog([`Test failed: ${getErrorMessage(err, "batch probe failed")}`]);
      toast.error("Test failed", getErrorMessage(err, "batch probe failed"));
    }
  };

  /**
   * Asks OpenCode, through each pasted endpoint, whether it will serve us.
   *
   * Separate from the URL test rather than a mode of it: the two answer
   * different questions, and an operator reading the log needs to know which
   * one produced a line. A blocked address still answers the URL test, so the
   * two results are not interchangeable.
   */
  const runTestOpencode = async () => {
    if (targets.length === 0) return;
    setLog([`Testing ${targets.length} proxy target(s) against OpenCode…`]);
    try {
      const results = await probeProviderBatch.mutateAsync({
        providerId: PROBE_PROVIDER_ID,
        targets,
      });
      const rows = results.map((entry) => {
        const { status, latencyMs, reason } = entry.result;
        const latency = latencyMs === undefined ? "" : ` · ${latencyMs}ms`;
        const detail = reason === undefined ? "" : ` · ${reason}`;
        return `${status === "allowed" ? "OK  " : status === "blocked" ? "BLOCK" : "FAIL"} ${entry.endpoint}${latency}${detail}`;
      });
      setProbeByEndpoint((prev) => {
        const next = { ...prev };
        for (const entry of results) next[entry.endpoint] = entry.result;
        return next;
      });
      const allowed = results.filter((r) => r.result.status === "allowed").length;
      const blocked = results.filter((r) => r.result.status === "blocked").length;
      setLog([`${allowed}/${results.length} allowed · ${blocked} blocked`, ...rows]);
      if (blocked === 0 && allowed === results.length) {
        toast.success(`OpenCode accepted all ${results.length} proxies`);
      } else {
        toast.error(`OpenCode: ${allowed} allowed · ${blocked} blocked`);
      }
    } catch (err) {
      setLog([`Test failed: ${getErrorMessage(err, "provider probe failed")}`]);
      toast.error("Test failed", getErrorMessage(err, "provider probe failed"));
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
          : splitQuotaAcrossFamily(quotaBytes, family, chippedLines.length);
      const outcomes: Array<{ ok: boolean; error?: string }> = new Array(lines.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < lines.length) {
          const index = cursor++;
          const line = chippedLines[index]!;
          try {
            const created = await createPool.mutateAsync({
              kind: detectProxyKind(line),
              endpoint: line,
              ...(perRowQuota.has(index) ? { quotaBytes: perRowQuota.get(index) } : {}),
              ...(family.trim() !== "" ? { family: family.trim() } : {}),
            });
            // Carry both verdicts the operator already paid for onto the row
            // that now exists, so the table shows them without a re-test.
            const probed = probeByEndpoint[line];
            const health = healthByEndpoint[line];
            if (created?.id) {
              if (health !== undefined) onHealthResult?.(created.id, health);
              if (probed !== undefined) onProbeResult?.(created.id, probed);
            }
            outcomes[index] = { ok: true };
          } catch (err) {
            outcomes[index] = { ok: false, error: getErrorMessage(err, "Proxy pool creation failed") };
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(BULK_POOL_CREATE_CONCURRENCY, lines.length) },
          () => worker(),
        ),
      );

      const failures: string[] = [];
      let ok = 0;
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.ok) {
          ok++;
        } else if (failures.length < 3) {
          failures.push(`${lines[index]!.slice(0, 48)}…: ${outcome.error}`);
        }
      }
      const fail = lines.length - ok;
      const firstFailure = outcomes.find((outcome) => !outcome.ok)?.error;
      if (ok > 0) {
        toast.success(
          `Added ${ok} proxy pool(s)`,
          fail ? `${fail} failed: ${firstFailure ?? "see the import details"}` : undefined,
        );
      }
      if (fail > 0 && ok === 0) {
        toast.error("Failed to create pool", firstFailure ?? "See the import details");
      }
      if (fail > 0) setError(failures.join("\n"));
      if (ok > 0) {
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
      <SchemeChipRow endpoint={firstLine} chip={chip} onChipChange={setChip} />
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
      {log.length > 0 && (
        <div
          role="log"
          aria-label="Proxy test results"
          aria-live="polite"
          className="scroll-region max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-inset border border-inner-border bg-surface-1 px-3 py-2 font-mono text-badge leading-[1.5] text-text-secondary"
        >
          {log.join("\n")}
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
