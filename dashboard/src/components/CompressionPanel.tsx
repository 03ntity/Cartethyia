import { Minimize2, Scissors, Sparkles, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Select } from "./ui/select";
import { Switch } from "./ui/switch";
import { Inline } from "./ui/inline";
import { Stack } from "./ui/stack";
import { ErrorState, LoadingState } from "./ui/state";
import { Badge } from "./ui/badge";
import { Banner } from "./patterns/banner";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../hooks/settings";

const STRENGTH_OPTIONS = [
  { value: "lite", label: "Lite" },
  { value: "full", label: "Full" },
  { value: "ultra", label: "Ultra" },
] as const;

const STRENGTH_LABEL: Record<string, string> = {
  lite: "Lite",
  full: "Full",
  ultra: "Ultra",
};

/**
 * One compression transform's row: a contained sub-panel with the icon, title,
 * status badge, description, and the strength dropdown + enable toggle. The
 * dropdown stays usable while off so the operator can pick a strength before
 * switching it on.
 */
function CompressionControl({
  id,
  label,
  description,
  icon,
  enabled,
  strength,
  strengthSelectId,
  onToggle,
  onStrength,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly enabled: boolean;
  readonly strength: string;
  readonly strengthSelectId: string;
  readonly onToggle: (next: boolean) => void;
  readonly onStrength: (value: string) => void;
}): ReactNode {
  return (
    <div className="rounded-control border border-inner-border bg-surface-2 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <label htmlFor={id}>
              <Inline gap="6px" className="text-body font-semibold">
                {icon}
                {label}
              </Inline>
            </label>
            <Badge tone={enabled ? "ok" : "default"} dot>
              {enabled ? `Active · ${STRENGTH_LABEL[strength] ?? strength}` : "Off"}
            </Badge>
          </div>
          <p className="mt-2 text-badge leading-normal text-text-tertiary">{description}</p>
        </div>
        <Inline gap="8px" className="shrink-0 items-center">
          <Select
            id={strengthSelectId}
            aria-label={`${label} strength`}
            value={strength}
            onValueChange={onStrength}
            options={STRENGTH_OPTIONS}
          />
          <Switch id={id} aria-label={`Enable ${label}`} checked={enabled} onChange={onToggle} />
        </Inline>
      </div>
    </div>
  );
}

/**
 * Request-compression controls (RTK prune + PonyTail), shown on the Overview
 * page above the API keys. Both are off by default and per-tenant. They reshape
 * the canonical request before dispatch: RTK prune compacts bulky tool-result
 * text, PonyTail appends a minimal-code directive to the system content.
 *
 * Each control is a strength dropdown with an enable toggle beside it. Both
 * transforms rewrite what the model sees, so the card carries a quality notice:
 * on, they can cost output quality — the trade is fewer tokens for a chance the
 * model reasons on less context.
 */
export function CompressionPanel(): ReactNode {
  const query = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const settings = query.data;
  if (query.isPending) return <LoadingState label="Loading compression settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(query.error, "Failed to load compression settings")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const rtkOn = settings.rtkPruneEnabled;
  const ponyOn = settings.ponyTailEnabled;
  const compressionOn = rtkOn || ponyOn;

  return (
    <Card>
      <CardHeader
        title="Compression"
        subtitle="Shrink requests before they reach the provider"
        icon={<Minimize2 size={16} />}
      />
      <CardBody>
        <Stack gap="14px">
          {compressionOn ? (
            <Banner tone="warning" surface="raised" live="status">
              <span className="flex items-start gap-3">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  Your AI may produce degraded quality while compression is active: it sees a
                  shortened history and a minimal-code directive, so fewer tokens but a chance of
                  missing detail. Turn it off if answers get worse.
                </span>
              </span>
            </Banner>
          ) : null}

          <CompressionControl
            id="compression-rtk"
            label="Prune tool output (RTK)"
            description="Compact bulky tool results (diffs, grep dumps, listings) in the message history so a long conversation stops re-sending megabytes of raw output. Higher strength compresses more aggressively."
            icon={<Scissors size={16} className="shrink-0 text-text-secondary" />}
            enabled={rtkOn}
            strength={settings.rtkPruneLevel}
            strengthSelectId="compression-rtk-level"
            onToggle={(next) =>
              mutation.mutate(
                { rtkPruneEnabled: next },
                {
                  onError: (error) =>
                    toast.error(getErrorMessage(error, "Could not update RTK prune.")),
                },
              )
            }
            onStrength={(value) =>
              mutation.mutate(
                {
                  rtkPruneLevel:
                    value === "lite" || value === "full" || value === "ultra" ? value : "full",
                },
                {
                  onError: (error) =>
                    toast.error(getErrorMessage(error, "Could not update RTK strength.")),
                },
              )
            }
          />

          <CompressionControl
            id="compression-ponytail"
            label="PonyTail (system directive)"
            description="Appends a minimal-code directive to the system content, biasing the model toward the smallest working change. Higher strength pushes harder toward deletion over addition."
            icon={<Sparkles size={16} className="shrink-0 text-text-secondary" />}
            enabled={ponyOn}
            strength={settings.ponyTailLevel}
            strengthSelectId="compression-ponytail-level"
            onToggle={(next) =>
              mutation.mutate(
                { ponyTailEnabled: next },
                {
                  onError: (error) =>
                    toast.error(getErrorMessage(error, "Could not update PonyTail.")),
                },
              )
            }
            onStrength={(value) =>
              mutation.mutate(
                {
                  ponyTailLevel:
                    value === "lite" || value === "full" || value === "ultra" ? value : "full",
                },
                {
                  onError: (error) =>
                    toast.error(getErrorMessage(error, "Could not update PonyTail strength.")),
                },
              )
            }
          />
        </Stack>
      </CardBody>
    </Card>
  );
}
