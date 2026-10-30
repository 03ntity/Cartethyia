import { Check, Copy, Globe, Loader2, RadioTower } from "lucide-react";
import { useState } from "react";
import { useEffect } from "react";
import { type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { Stack } from "../../components/ui/stack";
import { ApiKeysPanel } from "../../components/ApiKeysPanel";
import { CompressionPanel } from "../../components/CompressionPanel";
import { InjectSystemPromptPanel } from "../../components/InjectSystemPromptPanel";
import { useClipboard } from "../../hooks/use-clipboard";
import {
  useRemoteSupport,
  useStartRemoteSupport,
  useStopRemoteSupport,
} from "../../hooks/remote-support";
import type { RemoteSupportTool } from "../../data/contracts";
import { toast } from "../../lib/toast";

const REMOTE_SUPPORT_LABEL: Readonly<Record<RemoteSupportTool, string>> = {
  cloudflared: "cloudflared",
  tailscale: "Tailscale",
};

const REMOTE_SUPPORT_BLURB: Readonly<Record<RemoteSupportTool, string>> = {
  cloudflared: "Publish a temporary public URL without opening a port.",
  tailscale: "Give a helper a private address on your own tailnet.",
};

/**
 * Brand marks, drawn inline rather than pulled from an icon set.
 *
 * Neither Cloudflare nor Tailscale ships in `lucide-react` (it carries no
 * third-party logos), so the paths are inlined here. Both are single-colour
 * glyphs painted with `currentColor` so they follow the surrounding text and
 * stay legible across the light and dark themes; `aria-hidden` keeps them out
 * of the accessibility tree because the heading beside each one already names
 * the tool.
 */
function RemoteSupportLogo({ tool }: { readonly tool: RemoteSupportTool }): ReactNode {
  if (tool === "cloudflared") {
    // Cloudflare's cloud: the small mark tucked under the larger one.
    return (
      <svg viewBox="0 0 24 24" className="size-8 shrink-0" aria-hidden="true" fill="currentColor">
        <path d="M16.5 18.4a4.6 4.6 0 0 1-3.2-1.3l-6-5.9a2.4 2.4 0 0 0-3.3 0 2.3 2.3 0 0 0 0 3.3l5.4 5.3a.9.9 0 0 1-1.3 1.3L2.7 15.8a4.1 4.1 0 0 1 0-5.8 4.2 4.2 0 0 1 5.8 0l6 5.9a2.4 2.4 0 0 0 3.3 0 2.3 2.3 0 0 0 0-3.3l-4.2-4.1a.9.9 0 0 1 1.3-1.3l4.2 4.1a4.1 4.1 0 0 1 0 5.8 4.2 4.2 0 0 1-2.6 1.3Z" />
        <path d="M7.6 18.4a4.5 4.5 0 0 1-3-1.1 5.4 5.4 0 0 1-1.5-3.5 6 6 0 0 1 .4-2 .9.9 0 0 1 1.7.6 4.2 4.2 0 0 0-.3 1.4 3.6 3.6 0 0 0 1 2.3 2.7 2.7 0 0 0 1.8.7.9.9 0 0 1 0 1.8Z" />
      </svg>
    );
  }
  // Tailscale's stylised "T" formed by two interlocking rounded strokes.
  return (
    <svg viewBox="0 0 24 24" className="size-8 shrink-0" aria-hidden="true" fill="currentColor">
      <path d="M12 3.2a4.4 4.4 0 0 0-4.4 4.4v2.2H4.6a2.2 2.2 0 0 0 0 4.4h3v2.2a4.4 4.4 0 0 0 8.8 0v-2.2h1.1a3.3 3.3 0 0 0 0-6.6h-1.1V7.6A4.4 4.4 0 0 0 12 3.2Zm0 2.2a2.2 2.2 0 0 1 2.2 2.2v6.6a2.2 2.2 0 0 1-4.4 0V7.6A2.2 2.2 0 0 1 12 5.4Z" />
      <path d="M6.6 11h4.2v2.2H6.6zM13.2 11h4.2v2.2h-4.2z" />
    </svg>
  );
}

/**
 * One publisher's row: a toggle that starts or stops it, and the URL it
 * published once it is up.
 *
 * The toggle reflects server state, not local optimism: `checked` is derived
 * from the polled status, so a tunnel stopped out of band (or crashed) shows as
 * off without a click being lost.
 */
function RemoteSupportToggle({ tool }: { readonly tool: RemoteSupportTool }) {
  const status = useRemoteSupport();
  const start = useStartRemoteSupport();
  const stop = useStopRemoteSupport();
  const { copied, copy } = useClipboard(2000);
  const active = status.data?.active === tool;
  const pending = start.isPending || stop.isPending;
  const url = active ? status.data?.url ?? null : null;
  const [notice, setNotice] = useState<string | null>(null);
  const [localChecked, setLocalChecked] = useState(active);
  useEffect(() => {
    if (!start.isPending && !stop.isPending) setLocalChecked(active);
  }, [active, start.isPending, stop.isPending]);
  const flip = async (next: boolean) => {
    setLocalChecked(next);
    try {
      const result = next ? await start.mutateAsync(tool) : await stop.mutateAsync(tool);
      if (result.blocker !== null && result.message !== null) {
        setNotice(result.message);
        toast.error(result.message);
        setLocalChecked(!next);
        return;
      }
      setNotice(null);
      toast.success(next ? `${REMOTE_SUPPORT_LABEL[tool]} started` : `${REMOTE_SUPPORT_LABEL[tool]} stopped`);
    } catch {
      toast.error(`Could not ${next ? "start" : "stop"} ${REMOTE_SUPPORT_LABEL[tool]}`);
      setLocalChecked(!next);
    }
  };
  const copyUrl = async () => {
    if (url === null) return;
    if (await copy(url)) {
      toast.success("Remote URL copied", url);
      return;
    }
    toast.error("Clipboard unavailable on this origin");
  };
  return (
    <div className="rounded-control border border-inner-border bg-surface-2 p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <RemoteSupportLogo tool={tool} />
          <h3 className="text-caption font-semibold">{REMOTE_SUPPORT_LABEL[tool]}</h3>
        </div>
        <Switch
          checked={localChecked}
          disabled={pending}
          onChange={(next) => void flip(next)}
          aria-label={`Toggle ${REMOTE_SUPPORT_LABEL[tool]} remote support`}
        />
      </div>
      {start.isPending ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-badge text-text-secondary">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            <span className="animate-pulse">Waiting for address…</span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void flip(false)}>
            Cancel
          </Button>
        </div>
      ) : url !== null ? (
        <div className="mt-3 flex items-center gap-3">
          <code className="min-w-0 flex-1 truncate font-mono text-badge text-text-primary" title={url}>
            {url}
          </code>
          <Button variant="secondary" size="sm" onClick={() => void copyUrl()}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : notice !== null ? (
        <div className="mt-2 rounded-control border border-warning/30 bg-warning/10 p-3 text-badge leading-normal text-text-secondary">
          <p className="font-medium text-warning">Setup needed</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{notice}</p>
          {(() => {
            const m = notice.match(/https:\/\/login\.tailscale\.com\/f\/serve\?[^\s]+/);
            return m ? (
              <a
                href={m[0]}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block font-medium text-accent underline"
              >
                Enable Tailscale Serve →
              </a>
            ) : null;
          })()}
        </div>
      ) : (
        <p className="mt-2 text-badge leading-normal text-text-tertiary">
          {REMOTE_SUPPORT_BLURB[tool]}
        </p>
      )}
    </div>
  );
}


function ApiEndpointCard() {
  const { copied, copy } = useClipboard(2000);
  // The endpoint is served from the same origin the dashboard is, so the origin
  // is used exactly as the browser sees it. Rewriting it to the gateway's
  // default port breaks every deployment that listens on another port or sits
  // behind a TLS-terminating proxy — the dashboard loads over one authority and
  // the card would advertise a different one.
  const endpoint = `${window.location.origin}/v1`;
  const copyEndpoint = async () => {
    if (await copy(endpoint)) {
      toast.success("Gateway endpoint copied", endpoint);
      return;
    }
    toast.error("Clipboard unavailable on this origin");
  };
  return (
    <Card>
      <CardHeader
        title="Gateway Endpoint"
        subtitle="Universal OpenAI & Anthropic Wire API Endpoint Compatible"
        icon={<Globe size={16} />}
      />
      <CardBody>
        <Stack gap="10px">
          <div className="nested-panel flex items-center gap-4 rounded-control border border-inner-border bg-code-surface px-7 py-5 font-mono text-body font-semibold tabular-nums">
            <code className="min-w-0 flex-1 truncate" title={endpoint}>{endpoint}</code>
            <Button
              variant="secondary"
              size="sm"
              icon={copied ? <Check size={13} /> : <Copy size={13} />}
              aria-label="Copy endpoint"
              title="Copy endpoint"
              onClick={() => void copyEndpoint()}
              className="shrink-0"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-caption leading-normal text-text-secondary">
            Point any SDK, CLI, or coding agent — OpenCode, Pi, OMP, Kilo, Cline, Droid, and more — at this same-origin base URL.
            <span className="mt-1 block text-text-tertiary">
              For Claude Code, leave off <code className="font-mono">/v1</code> — its CLI appends it automatically.
            </span>
          </p>
        </Stack>
      </CardBody>
    </Card>
  );
}


/**
 * How to let someone reach this gateway from outside the local network.
 *
 * The gateway exposes no tunnel of its own and holds no tunnel state, so this
 * card documents the two supported ways to publish it rather than reporting a
 * status there is nothing to read. A tunnel terminates at the edge and the
 * gateway only ever sees a forwarded client address — see the boundary rules
 * in `src/security/ip-boundary.ts`, which exist precisely because a tunnel
 * collapses the peer address onto loopback.
 */
function RemoteSupportCard() {
  const status = useRemoteSupport();
  return (
    <Card>
      <CardHeader
        title="Remote Support"
        subtitle="Reach this gateway from outside the local network"
        icon={<RadioTower size={16} />}
      />
      <CardBody>
        <Stack gap="10px">
          <div className="grid grid-cols-2 gap-4 max-medium:grid-cols-1">
            <RemoteSupportToggle tool="cloudflared" />
            <RemoteSupportToggle tool="tailscale" />
          </div>
          {status.data?.blocker !== null && status.data?.message !== null ? (
            <p className="text-badge leading-normal text-red-primary">{status.data?.message}</p>
          ) : null}
          <p className="text-caption leading-normal text-text-secondary">
            No matter which tunnel you pick, the gateway sees the tunnel&apos;s address as the
            client. Add the forwarding edge to{" "}
            <code className="font-mono">TRUSTED_PROXY_CIDRS</code> so remote callers aren&apos;t
            recorded as loopback.
          </p>
          <p className="text-badge leading-normal text-text-tertiary">
            Cartethyia doesn&apos;t install cloudflared or Tailscale for you — set up either one
            yourself. Tunnels run detached from the gateway, so they keep working across restarts.
          </p>
        </Stack>
      </CardBody>
    </Card>
  );
}


export default function Overview(): ReactNode {
  return (
    <Stack gap="16px">
      <ApiEndpointCard />
      <RemoteSupportCard />
      <CompressionPanel />
      <InjectSystemPromptPanel />
      <ApiKeysPanel />
    </Stack>
  );
}
