import { ClipboardCopy } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Dialog } from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { Stack } from "../../../components/ui/stack";
import { Inline } from "../../../components/ui/inline";
import { toast } from "../../../lib/toast";
import {
  useImportNativeIdentity,
  useNativeIdentity,
  useRegenerateNativeIdentity,
} from "../../../hooks/providers";
import type { NativeIdentityRecord } from "../../../data/contracts";

function parseIdentity(raw: string): NativeIdentityRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      typeof rec.machineToken === "string" &&
      typeof rec.machineType === "string" &&
      typeof rec.machineCode === "string"
    ) {
      return {
        machineToken: rec.machineToken,
        machineType: rec.machineType,
        machineCode: rec.machineCode,
        ...(typeof rec.seed === "string" ? { seed: rec.seed } : {}),
        ...(rec.source === "generated" || rec.source === "runtime-info"
          ? { source: rec.source }
          : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function NativeIdentityDialog({
  accountId,
  onClose,
}: {
  readonly accountId: string;
  readonly onClose: () => void;
}): ReactNode {
  const identityQuery = useNativeIdentity(accountId);
  const identity = identityQuery.data?.identity ?? null;
  const importMutation = useImportNativeIdentity();
  const regenerateMutation = useRegenerateNativeIdentity();
  const [importDraft, setImportDraft] = useState("");

  const exportJson = useMemo(
    () => (identity ? JSON.stringify(identity, null, 2) : ""),
    [identity],
  );

  const handleCopy = async () => {
    if (!exportJson) return;
    try {
      await navigator.clipboard.writeText(exportJson);
      toast.success("Identity copied to clipboard");
    } catch {
      toast.error("Clipboard access denied");
    }
  };

  const handleRegenerate = () => {
    regenerateMutation.mutate({ accountId });
  };

  const handleImport = () => {
    const parsed = parseIdentity(importDraft);
    if (!parsed) {
      toast.error("Invalid identity JSON", "Expected { machineToken, machineType, machineCode }");
      return;
    }
    importMutation.mutate({ accountId, identity: parsed });
  };

  const busy = importMutation.isPending || regenerateMutation.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Native machine identity (Qoder)"
      description="The device identity the daily 100-credit check-in claims under. One device per account; exporting lets you move it to another instance."
      width={560}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button size="sm" variant="primary" onClick={handleRegenerate} disabled={busy || !identity}>
            {regenerateMutation.isPending ? "Regenerating…" : "Regenerate"}
          </Button>
        </>
      }
    >
      <Stack gap="10px">
        <div className="rounded-control border border-inner-border bg-surface-1 p-4">
          <div className="text-caption font-semibold text-text-secondary">
            Bound device
          </div>
          {identityQuery.isLoading ? (
            <div className="text-caption text-text-tertiary">Loading…</div>
          ) : identity ? (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex items-center gap-2 self-start">
                <span className="inline-flex items-center px-3 py-1 rounded-chip border border-inner-border bg-surface-2 text-badge text-text-primary">
                  {identity.source === "generated" ? "Generated · NOT claim-capable" : "Genuine · SG bridge"}
                </span>
                {!identity.seed && identity.source !== "generated" ? (
                  <span className="inline-flex items-center px-3 py-1 rounded-chip border border-inner-border bg-surface-2 text-badge text-text-tertiary">
                    no seed · hardware-bound (Windows)
                  </span>
                ) : null}
                {identity.seed ? (
                  <span className="inline-flex items-center px-3 py-1 rounded-chip border border-inner-border bg-surface-2 text-badge text-text-tertiary">
                    seed · {identity.seed.length} B
                  </span>
                ) : null}
              </div>
              <span className="font-mono text-micro text-text-tertiary break-all">
                {identity.machineToken.slice(0, 32)}… · {identity.machineType} · {identity.machineCode}
              </span>
            </div>
          ) : (
            <div className="mt-2 text-caption text-text-tertiary">
              Not bound — the check-in will mint a device identity on its next
              run.
            </div>
          )}
        </div>

        <div className="rounded-control border border-inner-border bg-surface-1 p-4">
          <div className="flex items-center justify-between">
            <span className="text-caption font-semibold text-text-secondary">Export</span>
            <Button
              size="sm"
              variant="secondary"
              icon={<ClipboardCopy size={12} />}
              onClick={() => void handleCopy()}
              disabled={!identity}
            >
              Copy JSON
            </Button>
          </div>
          <pre className="mt-2 max-h-48 overflow-auto rounded-control bg-input-bg border border-inner-border p-3 font-mono text-micro text-text-primary whitespace-pre-wrap break-all">
            {exportJson || "No identity bound yet."}
          </pre>
        </div>

        <div className="rounded-control border border-inner-border bg-surface-1 p-4">
          <div className="text-caption font-semibold text-text-secondary">Import</div>
          <textarea
            value={importDraft}
            onChange={(event) => setImportDraft(event.target.value)}
            placeholder='Paste identity JSON, e.g. {"machineToken":"…","machineType":"…","machineCode":"…"}'
            rows={4}
            spellCheck={false}
            className="mt-2 font-mono tabular-nums w-full min-w-0 rounded-control border border-inner-border bg-input-bg px-3 py-2 text-caption text-text-primary resize-y box-border"
          />
          <Inline gap="8px" className="mt-2 justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !importDraft.trim()}
              onClick={handleImport}
            >
              {importMutation.isPending ? "Binding…" : "Bind"}
            </Button>
          </Inline>
        </div>

        <p className="m-0 text-caption text-text-tertiary">
          Each account is bound to its own minted device identity. Two accounts
          must never share a device token; a bound account honestly reports
          “not eligible” when its device is spent for the day rather than
          shadowing another account's device.
        </p>
      </Stack>
    </Dialog>
  );
}
