import { Check, Copy, Globe, RadioTower } from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Stack } from "../../components/ui/stack";
import { ApiKeysPanel } from "../../components/ApiKeysPanel";
import { CompressionPanel } from "../../components/CompressionPanel";
import { useClipboard } from "../../hooks/use-clipboard";
import { toast } from "../../lib/toast";


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
            Point any SDK, CLI, or agent (e.g. OpenCode, Pi, OMP, Kilo, Cline, Droid and more clients) to this same-origin base URL.
            <span className="mt-1 block text-text-tertiary">
              You may not put <code className="font-mono">/v1</code> on Claude Code — the CLI appends it itself.
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
            <section
              aria-labelledby="remote-support-cloudflared"
              className="rounded-control border border-inner-border bg-surface-2 p-5"
            >
              <h3 id="remote-support-cloudflared" className="text-caption font-semibold">
                cloudflared
              </h3>
              <p className="mt-2 text-caption leading-normal text-text-secondary">
                Publish a temporary public URL without opening a port:
              </p>
              <code className="mt-3 block overflow-x-auto rounded-inset border border-inner-border bg-code-surface px-4 py-3 font-mono text-badge text-text-primary">
                cloudflared tunnel --url http://localhost:12800
              </code>
              <p className="mt-3 text-badge leading-normal text-text-tertiary">
                Best for one-off help. The URL changes each run unless you use a named
                tunnel.
              </p>
            </section>
            <section
              aria-labelledby="remote-support-tailscale"
              className="rounded-control border border-inner-border bg-surface-2 p-5"
            >
              <h3 id="remote-support-tailscale" className="text-caption font-semibold">
                Tailscale
              </h3>
              <p className="mt-2 text-caption leading-normal text-text-secondary">
                Give a helper a private address on your own tailnet:
              </p>
              <code className="mt-3 block overflow-x-auto rounded-inset border border-inner-border bg-code-surface px-4 py-3 font-mono text-badge text-text-primary">
                tailscale serve --bg --https=443 http://localhost:12800
              </code>
              <p className="mt-3 text-badge leading-normal text-text-tertiary">
                Best for ongoing access. Nothing is exposed to the public internet.
              </p>
            </section>
          </div>
          <p className="text-caption leading-normal text-text-secondary">
            Either way the gateway still sees the tunnel&apos;s address as the client, so set{" "}
            <code className="font-mono">TRUSTED_PROXY_CIDRS</code> to the edge that forwards to
            it — otherwise every remote caller is recorded as the loopback address.
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
      <ApiKeysPanel />
    </Stack>
  );
}
