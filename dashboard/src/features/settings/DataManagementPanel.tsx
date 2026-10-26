import { Activity, FileClock, FileJson, HardDrive, HardDriveDownload, Trash2, Zap, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { Stack } from "../../components/ui/stack";
import { Banner } from "../../components/patterns/banner";
import { formatBytes, formatNumber } from "../../lib/format/numbers";
import { toast } from "../../lib/toast";
import { getErrorMessage } from "../../data/api";
import { useDiskUsage, useFlushBuffers, usePurgeHealthEvents, useReclaimDisk } from "../../hooks/data-management";
import type { DiskUsageBucket, ReclaimAction } from "../../data/contracts";

/**
 * What is on disk, and two ways to act on it.
 *
 * The sizes exist to answer a question the operator cannot otherwise get: how
 * much space is this data actually taking, and how much of it is dead weight.
 * Each row therefore says what the data is *for*, because "412 MB" is only
 * actionable once you know whether deleting it costs you the request list or
 * nothing.
 *
 * Reclaim is confirm-then-run rather than immediate. Deleting is not
 * reversible, and the button sits next to a number the operator may have only
 * glanced at.
 */
export function DataManagementPanel(): ReactNode {
  const usage = useDiskUsage();
  const reclaim = useReclaimDisk();
  const flush = useFlushBuffers();
  const purge = usePurgeHealthEvents();
  const [confirming, setConfirming] = useState<ReclaimAction | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState(false);

  if (usage.isPending) return <LoadingState label="Measuring disk usage…" />;
  if (usage.isError || !usage.data) {
    return (
      <ErrorState
        message={getErrorMessage(usage.error, "Failed to measure disk usage")}
        onRetry={() => void usage.refetch()}
      />
    );
  }
  const data = usage.data;

  const run = (action: ReclaimAction | null): void => {
    if (action === null) return;
    setConfirming(null);
    reclaim.mutate(action, {
      onSuccess: (result) => {
        if (result.deletedFiles === 0) {
          toast.success("Nothing to reclaim.");
          return;
        }
        toast.success(
          `Reclaimed ${formatBytes(result.reclaimedBytes)} across ${formatNumber(
            result.deletedFiles,
          )} file${result.deletedFiles === 1 ? "" : "s"}.`,
        );
      },
      onError: (error) => toast.error(getErrorMessage(error, "Reclaim failed.")),
    });
  };

  const healthEventCount = data.healthEventCount;

  return (
    <Stack gap="14px">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <span className="text-caption text-text-tertiary">
          {formatBytes(data.totalBytes)} on disk across{" "}
          {formatNumber(data.buckets.reduce((sum, b) => sum + b.files, 0))} files
        </span>
        <Button
          variant="secondary"
          size="sm"
          icon={<HardDrive size={14} />}
          onClick={() => void usage.refetch()}
          disabled={usage.isFetching}
        >
          {usage.isFetching ? "Measuring…" : "Refresh"}
        </Button>
      </div>

      {/*
       * A grid of cards, so the three buckets can be compared at a glance
       * instead of read as prose. Each card is the same shape — label, size,
       * count, action — which is what makes the numbers scannable.
       *
       * Hourly files carry no reclaim action: the backend refuses to delete
       * them, so the card says why instead of offering a button that fails.
       */}
      {/*
       * Four cards in one row: the two disk buckets plus the health log and
       * the flush control. `auto-fit` with a floor rather than a fixed column
       * count, so a narrow window gets fewer columns instead of a row of
       * cards too thin to read — and no empty slot when one is absent.
       */}
      <div className="settings-bucket-grid">
        {data.buckets.map((bucket) => {
          const action = reclaimActionFor(bucket);
          return (
            <BucketCard
              key={bucket.id}
              bucket={bucket}
              busy={reclaim.isPending}
              confirming={action !== null && confirming === action}
              onAsk={() => setConfirming(action)}
              onCancel={() => setConfirming(null)}
              onConfirm={() => run(action)}
            />
          );
        })}
        <ActionCard
          icon={Activity}
          title="Health &amp; Error Log"
          note={
            healthEventCount === undefined
              ? "Purging is not offered in this deployment's console composition."
              : `${formatNumber(healthEventCount)} recorded transition${healthEventCount === 1 ? "" : "s"} across accounts and pools. Purge clears only this audit trail — account statuses and cooldowns stay as they are, and this cannot be undone.`
          }
          testId="health_events"
        >
          {healthEventCount === undefined ? null : confirmingPurge ? (
            <span className="flex flex-col gap-3">
              <span className="flex items-center gap-3">
                <Button variant="secondary" size="sm" onClick={() => setConfirmingPurge(false)} disabled={purge.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  disabled={purge.isPending}
                  onClick={() =>
                    purge.mutate(undefined, {
                      onSuccess: (result) => {
                        setConfirmingPurge(false);
                        toast.success(
                          result.deleted === 0
                            ? "Health & error log was already empty."
                            : `Purged ${formatNumber(result.deleted)} health event${result.deleted === 1 ? "" : "s"}.`,
                        );
                      },
                      onError: (error) => toast.error(getErrorMessage(error, "Purge failed.")),
                    })
                  }
                >
                  Delete
                </Button>
              </span>
            </span>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={<Trash2 size={14} />}
              disabled={purge.isPending || healthEventCount === 0}
              onClick={() => setConfirmingPurge(true)}
            >
              Purge
            </Button>
          )}
        </ActionCard>
        <ActionCard
          icon={HardDriveDownload}
          title="Flush pending writes"
          note="Write queued telemetry, usage, and health events now instead of waiting for the interval. Nothing is deleted."
          testId="flush"
        >
          <Button
            variant="secondary"
            size="sm"
            icon={<Zap size={14} />}
            disabled={flush.isPending}
            onClick={() =>
              flush.mutate(undefined, {
                onSuccess: () => toast.success("Buffers flushed."),
                onError: (error) => toast.error(getErrorMessage(error, "Flush failed.")),
              })
            }
          >
            {flush.isPending ? "Flushing…" : "Flush"}
          </Button>
        </ActionCard>
      </div>

      {reclaim.isError ? (
        <Banner tone="danger" surface="raised" live="status">
          {getErrorMessage(reclaim.error, "Reclaim failed.")}
        </Banner>
      ) : null}
    </Stack>
  );
}

/**
 * One action that is not a disk bucket, as a card with the same shape.
 *
 * The health log and the flush control used to render as two full-width rows
 * below a three-column grid holding two buckets, so the grid showed an empty
 * slot and the rows below it were a different width for no reason. Giving
 * them the bucket card's frame puts all four in one row of four.
 *
 * The body is a slot rather than props for a title and a note: the health log
 * needs a confirm/cancel pair where another card needs one button, and a
 * component that took both would be four props of which each card uses two.
 */
function ActionCard({
  icon: Icon,
  title,
  note,
  children,
  testId,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly note: string;
  readonly children: ReactNode;
  /** Stable hook for a test, so it need not walk up from the title. */
  readonly testId: string;
}): ReactNode {
  return (
    <div
      data-panel={testId}
      className="flex flex-col rounded-control border border-inner-border px-6 py-5 min-w-0"
    >
      <span className="flex items-start gap-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-surface-1 text-text-secondary">
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-caption text-text-tertiary">{title}</span>
          <span className="mt-1 block text-caption text-text-tertiary">{note}</span>
        </span>
      </span>
      {/*
       * Pinned to the bottom so the row's actions line up however the notes
       * wrap, and right-aligned so every card's button sits in the same
       * corner. A grid of cards is read column-wise as much as row-wise; with
       * the buttons all bottom-right, the eye finds the next action by
       * following the diagonal instead of hunting each card for its own.
       */}
      <div className="mt-auto flex justify-end pt-5">{children}</div>
    </div>
  );
}

/**
 * Which reclaim each bucket offers. Raw events can be reclaimed only after
 * their retention window; there is no summary/index action anymore.
 */
function reclaimActionFor(bucket: DiskUsageBucket): ReclaimAction | null {
  if (bucket.id === "payload_frames") return "payload_frames";
  if (bucket.id === "telemetry_events") return "telemetry_retention";
  return null;
}

/** One glyph per section, so the five parts of the panel read as a family. */
function bucketIconFor(bucket: DiskUsageBucket): LucideIcon {
  if (bucket.id === "payload_frames") return FileJson;
  return FileClock;
}

/**
 * One bucket, as a card.
 *
 * Size first: it is the number the operator came for, so it leads. The note is
 * one line because three of these sit side by side — a paragraph in each turns
 * the grid back into prose.
 */
function BucketCard({
  bucket,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  readonly bucket: DiskUsageBucket;
  readonly busy: boolean;
  readonly confirming: boolean;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const action = reclaimActionFor(bucket);
  const knownReclaimable = bucket.reclaimableBytes !== null;
  const reclaimable = bucket.reclaimableBytes ?? 0;
  const files = bucket.reclaimableFiles ?? 0;
  const nothingToReclaim = knownReclaimable && reclaimable === 0;
  const Icon = bucketIconFor(bucket);

  return (
    // `data-bucket` names the card, so a test asks for the card itself instead
    // of walking up from whichever nested element happened to hold the label.
    <div
      data-bucket={bucket.id}
      className="flex flex-col rounded-control border border-inner-border px-6 py-5 min-w-0"
    >
      <span className="flex items-start gap-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-surface-1 text-text-secondary">
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-caption text-text-tertiary">{bucket.label}</span>
          <span className="mt-1 block text-lead font-semibold text-text-primary">
            {formatBytes(bucket.bytes)}
          </span>
          <span className="block text-caption text-text-tertiary">
            {formatNumber(bucket.files)} file{bucket.files === 1 ? "" : "s"} · {bucket.note}
          </span>
        </span>
      </span>

      {/*
       * Pinned to the bottom so the three cards' actions line up even when
       * their notes wrap to different heights, and right-aligned so the
       * buttons share one corner across the row.
       */}
      <div className="mt-auto flex justify-end pt-5">
        {action === null ? (
          <p className="text-caption text-text-tertiary">Kept — no other copy.</p>
        ) : confirming ? (
          <span className="flex flex-col gap-3">
            <span className="text-caption text-text-secondary">
              {knownReclaimable
                ? `Delete ${formatNumber(files)} file${files === 1 ? "" : "s"}, ${formatBytes(reclaimable)}?`
                : "Delete raw event files past the retention window?"}
            </span>
            <span className="flex items-center gap-3">
              <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={onConfirm}
                disabled={busy}
              >
                Delete
              </Button>
            </span>
          </span>
        ) : (
          <span className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-caption text-text-tertiary">
              {!knownReclaimable
                ? "Expired events only"
                : nothingToReclaim
                  ? "Clean"
                  : `${formatBytes(reclaimable)} free`}
            </span>
            <Button
              variant="secondary"
              size="sm"
              icon={<Trash2 size={14} />}
              onClick={onAsk}
              disabled={busy || nothingToReclaim}
            >
              Reclaim
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
