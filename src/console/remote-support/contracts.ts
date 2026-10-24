/**
 * Remote-support tunnel contracts.
 *
 * A tunnel publishes the loopback gateway to a public or tailnet address. This
 * module owns the vocabulary (which tool, which states, what a status reports)
 * and is deliberately free of Elysia and Node imports so the dashboard can
 * import the same shape without dragging a server runtime into the browser
 * bundle.
 */

/** The two supported publishers. Both must already be installed. */
export const REMOTE_SUPPORT_TOOLS = ["cloudflared", "tailscale"] as const;

export type RemoteSupportTool = (typeof REMOTE_SUPPORT_TOOLS)[number];

/**
 * Why a tunnel cannot start. `not_installed` is the common one: this product
 * never installs third-party binaries, so a missing `cloudflared` or
 * `tailscale` is reported for the operator to install, never downloaded.
 */
export type RemoteSupportBlocker =
  | "not_installed"
  | "unsupported_platform"
  | "launch_failed";

export interface RemoteSupportStatus {
  /** Which publisher is up, or `null` when neither is. */
  readonly active: RemoteSupportTool | null;
  /** The published base URL, present once the publisher reported one. */
  readonly url: string | null;
  /** Set when a start was refused, with the operator-facing reason. */
  readonly blocker: RemoteSupportBlocker | null;
  /** Operator-facing detail for `blocker`, e.g. the install hint. */
  readonly message: string | null;
  /** Local port the tunnel forwards to. */
  readonly port: number;
  /** Which publishers are installed on this host. Cached so the UI doesn't poll. */
  readonly installed: Readonly<Record<RemoteSupportTool, boolean>>;
}

export interface RemoteSupportStartRequest {
  readonly tool: RemoteSupportTool;
  /** Defaults to the gateway's own port when omitted. */
  readonly port?: number;
}

export interface RemoteSupportStartResponse extends RemoteSupportStatus {
  readonly started: boolean;
}

/** Human-readable install guidance, keyed by tool. Never an installer. */
export const REMOTE_SUPPORT_INSTALL_HINT: Readonly<Record<RemoteSupportTool, string>> = {
  cloudflared:
    "cloudflared is not installed. Install it yourself (winget install Cloudflare.cloudflared) and try again.",
  tailscale:
    "tailscale is not installed. Install it yourself (winget install Tailscale.Tailscale), run `tailscale up` once, then try again.",
};

export function isRemoteSupportTool(value: unknown): value is RemoteSupportTool {
  return typeof value === "string" && (REMOTE_SUPPORT_TOOLS as readonly string[]).includes(value);
}
