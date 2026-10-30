import { ArrowDown, ArrowUp, Ban, ChevronDown, ChevronRight, ChevronsUpDown, Eye, EyeOff, Link2, RefreshCw, RotateCw } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dialog } from "./ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { ClipboardButton } from "./patterns/clipboard-button";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import { quotaBarTone } from "../lib/format/quota";
import { compactTokens } from "../lib/format/tokens";
import type { ApiKeyResponse, SharedKeyActivityDetail, SharedKeySummary } from "../data/contracts";
import {
  useRegenerateApiKey,
  useRevealApiKey,
  useRevokeSharedKey,
  useRevokeSharedScope,
  useShareApiKey,
  useShareLink,
  useSharedKeyActivity,
  useSharedKeys,
} from "../hooks/api-keys";
import type { SharedChildSortColumn } from "../data/contracts";

const count = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const stamp = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "—");
/**
 * A personal key's stored secret, hidden until the owner asks for it. The
 * reveal is a round trip because the list never carries the plaintext; once
 * it is back, Copy takes it verbatim.
 */
function PersonalKeyReveal({ keyId }: { readonly keyId: string }): ReactNode {
  const reveal = useRevealApiKey();
  const [secret, setSecret] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  const onReveal = () => {
    if (secret !== null) {
      setVisible((current) => !current);
      return;
    }
    reveal.mutate(
      { keyId },
      {
        onSuccess: (result) => {
          setSecret(result.secret);
          setVisible(true);
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not reveal the key.")),
      },
    );
  };

  return (
    <div className="flex min-w-0 items-center gap-4 rounded-control border border-inner-border bg-surface-2 px-5 py-4 text-text-tertiary">
      <code title={visible && secret ? secret : undefined} className="min-w-0 flex-auto overflow-hidden font-mono text-caption text-text-primary text-ellipsis whitespace-nowrap">
        {visible && secret ? secret : "••••••••••••••••"}
      </code>
      <Button
        variant="secondary"
        size="sm"
        icon={visible ? <EyeOff size={13} /> : <Eye size={13} />}
        loading={reveal.isPending}
        disabled={reveal.isPending}
        onClick={onReveal}
      >
        {visible ? "Hide" : "Reveal"}
      </Button>
      {visible && secret ? (
        <ClipboardButton value={secret} size="sm" variant="secondary" label="Copy" copiedLabel="Copied" />
      ) : null}
    </div>
  );
}

/** One limit rendered as a compact labelled figure; "Unlimited" when unset. */
function Limit({ label, value }: { label: string; value: number | null | undefined }): ReactNode {
  return (
    <div className="min-w-0 flex-1 basis-60 rounded-control border border-inner-border bg-surface-2 px-5 py-3">
      <dt className="text-badge font-normal tracking-label text-text-tertiary uppercase">{label}</dt>
      <dd className="mt-1 text-caption font-normal text-text-primary tabular-nums">{value == null ? "Unlimited" : count(value)}</dd>
    </div>
  );
}

/**
 * What regenerating costs, per key mode.
 *
 * Exported so the confirmation copy is testable without a DOM: `Dialog` renders
 * through `createPortal` behind a `mounted` effect, which never runs under
 * `renderToStaticMarkup`, so the dialog's body cannot be asserted through a
 * render. The two modes destroy different things and the copy must not be
 * swapped between them, which is exactly what needs a test.
 */
export function regenerateWarning(isPersonal: boolean): {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
} {
  if (isPersonal)
    return {
      title: "Regenerate this key?",
      message:
        "This rotates the key credential. Any client still using the current secret starts getting 401s immediately, and the old secret cannot be recovered. The handoff link is re-pointed to reveal the new key.",
      confirmLabel: "Regenerate key",
    };
  return {
    title: "Regenerate this link?",
    message:
      "This replaces the link URL; the current URL stops resolving immediately. Recipients keep the keys they already generated and keep working — but no one can enroll through the old link again.",
    confirmLabel: "Regenerate link",
  };
}

/**
 * Lifetime-budget consumption as a bar.
 *
 * Only the lifetime budget can be drawn honestly. The gateway enforces daily and
 * monthly token limits from in-memory windows in the admission service, which are
 * never persisted and never sent to the console, so the only counter the response
 * carries is `tokensConsumed` (lifetime). Drawing a daily or monthly bar would
 * mean rendering a zero the operator had no way to distinguish from a real zero.
 *
 * With no budget set the bar is drawn full and green: nothing is being consumed
 * against a limit, so the honest reading is headroom, not an empty bar that
 * would imply an exhausted budget.
 */
function BudgetBar({
  consumed,
  budget,
}: {
  readonly consumed: number;
  readonly budget: number | null | undefined;
}): ReactNode {
  const unlimited = budget == null || budget <= 0;
  const pct = unlimited ? 100 : Math.min(100, (consumed / budget) * 100);
  // Over-budget reads as full rather than clipping: the number is what tells the
  // operator they are past it, and a bar that shrinks back would imply headroom.
  const exhausted = !unlimited && consumed >= budget;
  return (
    <div className="grid flex-auto basis-full gap-2.5 rounded-control border border-inner-border bg-surface-2 px-5 py-3.5">
      <div className="flex items-baseline justify-between gap-4 text-badge tracking-label text-text-tertiary uppercase">
        <span>Lifetime budget</span>
        <span className="text-caption font-normal text-text-primary tabular-nums normal-case tracking-normal">
          {unlimited
            ? `${compactTokens(consumed)} · Unlimited`
            : `${compactTokens(consumed)} / ${compactTokens(budget)}`}
        </span>
      </div>
      <div
        className="h-3 overflow-hidden rounded bg-inner-border"
        role="progressbar"
        aria-label="Lifetime token budget consumed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={
          unlimited
            ? `${compactTokens(consumed)} tokens consumed, no lifetime budget set`
            : `${compactTokens(consumed)} of ${compactTokens(budget)} tokens consumed`
        }
      >
        <div
          className={exhausted ? "h-full rounded bg-status-danger" : "h-full rounded bg-status-success"}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * How many revokes run at once.
 *
 * Six, not one and not unlimited: a popular template can hold hundreds of
 * recipients, so sequential revoking made "Revoke all" take as long as the
 * list, while unbounded parallelism would send the whole list at once. Each
 * call is one DELETE against the console, so six keeps the burst ordinary
 * without making the operator wait on the list.
 */
/** Rows loaded per fetch; grows on scroll, capped by the endpoint at 500. */
const PAGE_SIZE = 25;
const PAGE_GROWTH = 25;
const MAX_SHARED_CHILD_LIMIT = 500;

/**
 * Parent-level quota bar: consumed vs budget, with the remaining pill.
 *
 * Same visual language as the quota page (`quota-bar-*` tones by remaining
 * percent), but the numbers here are the parent's: total children consumption
 * against the parent's lifetime budget, or the raw total when no budget is
 * set. Shown in its own section below the link, above the recipients table.
 */
function ParentQuotaBar({
  consumed,
  budget,
}: {
  readonly consumed: number;
  readonly budget: number | null | undefined;
}): ReactNode {
  if (budget == null) {
    return (
      <div className="grid flex-auto basis-full gap-2.5 rounded-control border border-inner-border bg-surface-2 px-5 py-3.5">
        <div className="flex items-baseline justify-between gap-4 text-badge tracking-label text-text-tertiary uppercase">
          <span>Total quota used</span>
          <span className="text-caption font-normal text-text-primary tabular-nums normal-case tracking-normal">{compactTokens(consumed)}</span>
        </div>
      </div>
    );
  }
  const pct = budget > 0 ? Math.min(100, (consumed / budget) * 100) : 0;
  const remaining = budget > 0 ? Math.max(0, 100 - (consumed / budget) * 100) : 100;
  const left = Math.max(0, budget - consumed);
  const colors = quotaBarTone(consumed >= budget ? 0 : remaining);
  const exhausted = consumed >= budget;
  return (
    <div className="grid flex-auto basis-full gap-2.5 rounded-control border border-inner-border bg-surface-2 px-5 py-3.5">
      <div className="flex items-baseline justify-between gap-4 text-badge tracking-label text-text-tertiary uppercase">
        <span>Total quota</span>
        <span className="text-caption font-normal text-text-primary tabular-nums normal-case tracking-normal">
          {compactTokens(consumed)} / {compactTokens(budget)}
        </span>
        <span
          className="border rounded-chip px-4 py-0.5 text-caption font-bold whitespace-nowrap tabular-nums"
          style={{ color: colors.text, borderColor: colors.text }}
        >
          {exhausted ? "Exhausted" : `${compactTokens(left)} left`}
        </span>
      </div>
      <div
        className="h-3 overflow-hidden rounded bg-inner-border"
        role="progressbar"
        aria-label="Total quota consumed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`${compactTokens(consumed)} of ${compactTokens(budget)} tokens consumed`}
      >
        <div
          className={exhausted ? "h-full rounded bg-status-danger" : "h-full rounded"}
          style={{ width: `${pct}%`, background: exhausted ? undefined : colors.bar }}
        />
      </div>
    </div>
  );
}

/** Expanded recipient body: model totals and recent requests, loaded on demand. */
export function ChildDetail({ parentId, childId }: { parentId: string; childId: string }): ReactNode {
  const detail = useSharedKeyActivity(parentId, childId);
  if (detail.isPending) return <LoadingState label="Loading activity…" compact />;
  if (detail.isError) {
    return (
      <ErrorState
        compact
        message={getErrorMessage(detail.error, "Could not load activity.")}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const activity: SharedKeyActivityDetail | undefined = detail.data;
  if (!activity) return null;
  return (
    <div className="grid min-w-0 gap-6 border-t border-inner-border bg-surface-1 px-6 py-5">
      <section>
        <h4 className="mb-3 text-caption font-bold text-text-primary">Top models</h4>
        {activity.models.length ? (
          <div className="data-table-container">
            <table className="data-table text-caption">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Today</th>
                  <th scope="col">Errors</th>
                  <th scope="col">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {activity.models.map((model, i) => (
                  <tr key={`${model.providerId ?? ""}-${model.modelId}-${i}`}>
                    <td>{model.modelId}</td>
                    <td>{count(model.todayRequests)}</td>
                    <td>{count(model.todayErrors)}</td>
                    <td>{compactTokens(model.todayTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-3 text-caption text-text-tertiary">No model activity yet.</p>
        )}
      </section>
      <section>
        <h4 className="mb-3 text-caption font-bold text-text-primary">Recent requests</h4>
        {activity.requests.length ? (
          <div className="data-table-container">
            <table className="data-table text-caption">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Status</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody>
                {activity.requests.map((event) => (
                  <tr key={event.requestId}>
                    <td>
                      {event.providerId ?? "Provider"}/{event.modelId ?? "Model"}
                    </td>
                    <td>
                      {event.status}
                      {event.httpStatus ? ` · ${event.httpStatus}` : ""}
                    </td>
                    <td>{compactTokens(event.totalTokens)}</td>
                    <td>{stamp(event.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-3 text-caption text-text-tertiary">No recent requests.</p>
        )}
      </section>
    </div>
  );
}

/**
 * The dialog's body. Split from the portal so the section logic — which query
 * is enabled, which section a key mode gets — is renderable without a DOM,
 * which the `Dialog`'s `createPortal` requires.
 */
export function ShareManagementContent({
  parent,
  onSecretRevealed,
}: {
  parent: ApiKeyResponse;
  /**
   * Called with the freshly generated plaintext when a personal key's
   * credential is rotated. The owner needs to read the new secret, and the
   * console returns it only once, so the host surfaces it in the one-time
   * reveal dialog rather than leaving the rotate as a toast the operator cannot
   * act on.
   */
  onSecretRevealed?: (secret: string) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState<string | null>(null);
  // Revoked recipients stay listed for their usage history, so an unfiltered
  // list grows without bound; defaulting to active is the view an operator
  // acts on. The filter is applied server-side — the family can hold hundreds
  // of thousands of children, so the client must never pull them all to
  // filter locally.
  const [statusFilter, setStatusFilter] = useState<"active" | "revoked">("active");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [sortBy, setSortBy] = useState<SharedChildSortColumn>("createdAt");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [confirmingBulk, setConfirmingBulk] = useState<"all" | "unused" | null>(null);
  const share = useShareApiKey();
  const regenerate = useRegenerateApiKey();
  const revoke = useRevokeSharedKey();
  const revokeScope = useRevokeSharedScope();
  const link = useShareLink(parent.id);
  const isPersonal = parent.keyMode !== "share";
  // A personal key has no recipients: `/shared-keys` is a share-template route
  // and answers 404 for it, so the query stays disabled instead of rendering an
  // error box over the key's own usage.
  const summary = useSharedKeys(isPersonal ? null : parent.id, {
    limit,
    offset: 0,
    sortBy,
    order,
    status: statusFilter,
  });
  const pageData = summary.data;
  const children = pageData?.rows ?? [];
  const activeTotal = pageData?.active ?? 0;
  // Rows arrive pre-filtered by `status`; `children` is the set loaded so far
  // (it grows as the operator scrolls, exactly like the usage page).
  const visibleChildren = children;

  const resetList = () => {
    setExpanded(null);
    setLimit(PAGE_SIZE);
  };

  const toggleSort = (column: SharedChildSortColumn) => {
    if (sortBy === column) {
      setOrder((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setOrder("asc");
    }
    resetList();
  };

  // Auto-pagination: near the bottom of the scroll container, load more rows
  // (mirrors the requests table on the usage page).
  const handleTableScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 40) {
      if (!summary.isFetching && children.length >= limit && limit < MAX_SHARED_CHILD_LIMIT) {
        setLimit((current) => Math.min(current + PAGE_GROWTH, MAX_SHARED_CHILD_LIMIT));
      }
    }
  };

  const SortHeader = ({ column, children: label }: { column: SharedChildSortColumn; children: ReactNode }) => {
    const active = sortBy === column;
    return (
      <th scope="col">
        <button
          type="button"
          onClick={() => toggleSort(column)}
          className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-inherit text-inherit hover:text-text-primary"
          aria-label={`Sort by ${String(column)}`}
        >
          {label}
          {active ? (
            order === "asc" ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />
          ) : (
            <ChevronsUpDown size={12} aria-hidden="true" className="text-text-tertiary" />
          )}
        </button>
      </th>
    );
  };

  useEffect(() => {
    setExpanded(null);
  }, [parent.id]);

  /**
   * Revokes every recipient in the chosen scope, server-side, so the operation
   * spans the whole family (not just the rows currently loaded). The endpoint
   * runs batched deletes; the response reports how many were revoked.
   */
  const onRevokeScope = async (scope: "active" | "unused"): Promise<void> => {
    try {
      const result = await revokeScope.mutateAsync({ parentKeyId: parent.id, scope });
      setLimit(PAGE_SIZE);
      toast.success(`Revoked ${result.deleted.toLocaleString()} recipient${result.deleted === 1 ? "" : "s"}.`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not revoke recipients."));
    }
  };

  const busy = share.isPending || regenerate.isPending;
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);

  /**
   * Regenerating is irreversible, so it confirms first.
   *
   * The two modes destroy different things, which is why the copy is not shared.
   * A personal key's regenerate rotates the credential itself, so every client
   * still holding the old secret starts getting 401s. A share template's
   * regenerate rotates only the link token in place (`share_links` is updated,
   * not re-created), so the old URL stops resolving while recipients keep the
   * keys they already generated — nothing they hold is deleted. Saying "all old
   * keys are deleted" would be false for share mode, and saying "recipients keep
   * their keys" would be dangerous for personal mode.
   */
  const onRegenerate = async (): Promise<void> => {
    if (isPersonal) {
      const result = await regenerate.mutateAsync({ keyId: parent.id });
      // The new secret is returned once: hand it to the host so it can be shown
      // in the one-time reveal dialog. A toast alone would leave the operator
      // unable to read the credential they just rotated to.
      onSecretRevealed?.(result.secret);
      return;
    }
    await share.mutateAsync({ keyId: parent.id, regenerate: true });
    toast.success("Link regenerated; the previous URL no longer works.");
  };

  const onEnsureLink = () => {
    share.mutate(
      { keyId: parent.id },
      { onError: (error) => toast.error(getErrorMessage(error, "Could not create link.")) },
    );
  };

  const url = link.data?.url ?? null;
  const warning = regenerateWarning(isPersonal);

  return (
    <div className="grid min-w-0 gap-6">
      <section aria-label="Link">
        {link.isPending ? (
          <LoadingState label="Loading link…" compact />
        ) : link.isError ? (
          <ErrorState
            compact
            message={getErrorMessage(link.error, "Could not load the link.")}
            onRetry={() => void link.refetch()}
          />
        ) : url ? (
          <div className="flex min-w-0 flex-wrap items-center gap-4 rounded-control border border-inner-border bg-surface-2 px-5 py-4 text-text-tertiary">
            <Link2 size={14} aria-hidden="true" className="shrink-0" />
            {/* The URL truncates to keep the row from scrolling the modal; the
                full value stays readable on hover and Copy takes it verbatim. */}
            <code title={url} className="min-w-0 flex-auto overflow-hidden font-mono text-caption text-text-primary text-ellipsis whitespace-nowrap">{url}</code>
            <ClipboardButton value={url} size="sm" variant="secondary" label="Copy" copiedLabel="Copied" />
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCw size={13} />}
              loading={busy}
              disabled={busy}
              onClick={() => setConfirmingRegenerate(true)}
            >
              Regenerate
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-4 rounded-control border border-inner-border bg-surface-2 px-5 py-4 text-text-tertiary">
            <Link2 size={14} aria-hidden="true" className="shrink-0" />
            <span className="flex-auto text-caption text-text-tertiary">No link yet.</span>
            <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={onEnsureLink}>
              Create link
            </Button>
          </div>
        )}
      </section>

      {isPersonal ? (
        <section aria-label="API key" className="grid gap-3">
          <div className="flex items-center justify-between gap-4">
            <strong className="text-caption">API key</strong>
          </div>
          <PersonalKeyReveal keyId={parent.id} />
        </section>
      ) : null}

      {isPersonal ? (
        <section aria-label="Usage" className="grid gap-3">
          <div className="flex items-center justify-between gap-4">
            <strong className="text-caption">Usage</strong>
          </div>
          <dl className="m-0 flex flex-wrap gap-3">
            <div className="min-w-0 flex-1 basis-60 rounded-control border border-inner-border bg-surface-2 px-5 py-3">
              <dt className="text-badge font-normal tracking-label text-text-tertiary uppercase">Lifetime tokens</dt>
              <dd className="mt-1 text-caption font-normal text-text-primary tabular-nums">{compactTokens(parent.tokensConsumed)}</dd>
            </div>
            <Limit label="Requests / min" value={parent.requestsPerMinute} />
            <Limit label="Daily tokens" value={parent.dailyTokenLimit} />
            <Limit label="Monthly tokens" value={parent.monthlyTokenLimit} />
            <BudgetBar consumed={parent.tokensConsumed} budget={parent.lifetimeTokenBudget} />
          </dl>
        </section>
      ) : (
        <>
          <section aria-label="Total quota" className="grid gap-3">
            <div className="flex items-center justify-between gap-4">
              <strong className="text-caption">Total quota</strong>
            </div>
            <ParentQuotaBar
              consumed={pageData?.consumed ?? 0}
              budget={parent.lifetimeTokenBudget}
            />
          </section>
          <section aria-label="Recipients" className="grid gap-3">
          <div className="flex items-center justify-between gap-4">
            <strong className="text-caption">Recipients</strong>
            {/* Counting only unrevoked children: a revoked key is still listed
                for its usage history, but it can no longer be used, so folding
                it into "active" would overstate who can still call the gateway. */}
            <span className="mr-2 ml-auto text-caption text-text-tertiary tabular-nums">
              Active users: {activeTotal.toLocaleString()}
            </span>
            <div className="inline-flex items-center gap-1 rounded-chip border border-inner-border p-0.5" role="group" aria-label="Filter recipients by status">
              {(["active", "revoked"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={statusFilter === value}
                  onClick={() => {
                    resetList();
                    setStatusFilter(value);
                  }}
                  className={`rounded-chip border-0 px-3 py-1 text-badge font-semibold capitalize cursor-pointer ${
                    statusFilter === value
                      ? "bg-surface-1 text-text-primary"
                      : "bg-transparent text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
            {confirmingBulk !== null ? (
              <span className="inline-flex items-center gap-2 rounded-chip border border-danger-border bg-surface-2 px-3 py-1">
                <span className="text-badge text-text-secondary">
                  {confirmingBulk === "all"
                    ? "Revoke all active recipients?"
                    : "Revoke all active recipients that never spent a token?"}
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  loading={revokeScope.isPending}
                  onClick={() => {
                    const scope = confirmingBulk === "all" ? "active" : "unused";
                    setConfirmingBulk(null);
                    void onRevokeScope(scope);
                  }}
                >
                  Confirm
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingBulk(null)}>
                  Cancel
                </Button>
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={activeTotal === 0 || revokeScope.isPending}
              title={
                activeTotal === 0
                  ? "No active recipients"
                  : `Revoke every active recipient (${activeTotal.toLocaleString()})`
              }
              onClick={() => setConfirmingBulk("unused")}
              icon={<Ban size={13} />}
            >
              Revoke no-usage
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={activeTotal === 0 || revokeScope.isPending}
              title={
                activeTotal === 0
                  ? "No active recipients"
                  : `Revoke all active recipients (${activeTotal.toLocaleString()})`
              }
              onClick={() => setConfirmingBulk("all")}
              icon={<Ban size={13} />}
            >
              Revoke all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void summary.refetch()}
              icon={
                /* A refresh with no visible motion reads as a dead button: the
                   list already polls every 5s, so a manual refresh that looks
                   identical to an idle one gives the operator no evidence their
                   click did anything. Spin only while the refetch is in flight. */
                <RefreshCw size={13} className={summary.isFetching ? "animate-spin" : undefined} />
              }
            >
              Refresh
            </Button>
          </div>
          {summary.isPending && !summary.data ? (
            <LoadingState label="Loading recipients…" compact />
          ) : summary.isError ? (
            <ErrorState
              compact
              message={getErrorMessage(summary.error, "Could not load recipients.")}
              onRetry={() => void summary.refetch()}
            />
          ) : visibleChildren.length === 0 ? (
            <EmptyState
              compact
              title={statusFilter === "revoked" ? "No revoked recipients" : "No active recipients"}
              message={
                statusFilter === "revoked"
                  ? "Revoked keys appear here once a recipient's key is revoked."
                  : "Keys generated through this link appear here with their masked client IP and token usage."
              }
            />
          ) : (
            <div className="data-table-container max-h-[46vh]" onScroll={handleTableScroll}>
              <table className="data-table text-caption">
                <thead>
                  <tr>
                    <th scope="col" className="w-12" aria-label="Expand" />
                    <SortHeader column="label">Key</SortHeader>
                    <SortHeader column="revokedAt">Status</SortHeader>
                    <th scope="col">Today</th>
                    <th scope="col">Lifetime</th>
                    <th scope="col">Last activity</th>
                    <SortHeader column="createdAt">Created</SortHeader>
                    <th scope="col" className="text-right whitespace-nowrap">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleChildren.map((child: SharedKeySummary) => {
                    const open = expanded === child.id;
                    return (
                      <Fragment key={child.id}>
                        <tr>
                          <td>
                            <button
                              type="button"
                              className="grid h-11 w-11 place-items-center rounded-chip border-0 bg-transparent p-0 text-text-secondary hover:bg-hover hover:text-text-primary"
                              aria-expanded={open}
                              aria-label={open ? "Collapse recipient" : "Expand recipient"}
                              onClick={() => setExpanded(open ? null : child.id)}
                            >
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td>
                            <code>{child.label || child.keyPrefix || "key"}…</code>
                            <div className="mt-1 text-badge text-text-tertiary wrap-anywhere">
                              {child.issuedClientIp ?? "IP hidden"}
                            </div>
                          </td>
                          <td>{child.revokedAt ? "revoked" : "active"}</td>
                          <td>{compactTokens(child.today.totalTokens)}</td>
                          <td>{compactTokens(child.allTime.totalTokens)}</td>
                          <td>{stamp(child.lastUsedAt)}</td>
                          <td>{stamp(child.createdAt)}</td>
                          <td className="text-right whitespace-nowrap">
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={revoke.isPending || Boolean(child.revokedAt)}
                              onClick={() =>
                                revoke.mutate(
                                  { parentKeyId: parent.id, childKeyId: child.id },
                                  {
                                    onError: (error) =>
                                      toast.error(getErrorMessage(error, "Could not revoke key.")),
                                  },
                                )
                              }
                            >
                              Revoke
                            </Button>
                          </td>
                        </tr>
                        {open ? (
                          <tr>
                            <td colSpan={8} className="p-0">
                              <ChildDetail parentId={parent.id} childId={child.id} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {summary.isFetching && children.length > 0 ? (
                <div className="border-t border-inner-border py-2 text-center text-badge text-text-tertiary">
                  Loading more…
                </div>
              ) : null}
              {children.length > 0 && children.length >= limit && limit < MAX_SHARED_CHILD_LIMIT ? (
                <div className="py-2 text-center text-badge text-text-tertiary">
                  Scroll for more
                </div>
              ) : null}
            </div>
          )}
          </section>
        </>
      )}
        {/* Nested rather than a sibling: `Dialog` renders through
            `createPortal`, so this adds no DOM child and cannot become a stray
            row in the `.share-modal` grid. */}
        <ConfirmDialog
          open={confirmingRegenerate}
          onClose={() => setConfirmingRegenerate(false)}
          onConfirm={onRegenerate}
          title={warning.title}
          message={warning.message}
          confirmLabel={warning.confirmLabel}
          danger
        />
      </div>
  );
}

export function ShareManagementDialog({
  parent,
  onClose,
  onSecretRevealed,
}: {
  parent: ApiKeyResponse;
  onClose: () => void;
  onSecretRevealed: (secret: string) => void;
}): ReactNode {
  const isPersonal = parent.keyMode !== "share";
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Sharing — ${parent.label || "API key"}`}
      description={
        isPersonal
          ? "One stable handoff link for this key. Regenerating rotates the key itself."
          : "One stable enrollment link. Regenerating replaces the URL; recipients keep the keys they already generated."
      }
      size="lg"
    >
      <ShareManagementContent parent={parent} onSecretRevealed={onSecretRevealed} />
    </Dialog>
  );
}
