import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Activity } from "lucide-react";
import { StatCard } from "../../../components/ui/layout";
import { formatNumber } from "../../../lib/format/numbers";
import { useInFlight, type InFlightState } from "../../../hooks/live";

/**
 * Live in-flight gauge for the Requests card header: `50 in flight · 40 IPs`.
 * The two numbers answer different questions — the count is the load, the IP
 * split is its shape — so one client hammering (`5 in flight · 1 IP`) reads
 * differently from the whole fleet (`5 in flight · 5 IPs`). Green pulse while
 * the SSE stream pushes, grey with the last value when the stream drops.
 */
function InFlightPill({
  count,
  uniqueIps,
  live,
}: {
  count: number | null;
  uniqueIps: number | null;
  live: boolean;
}): ReactNode {
  const active = count;
  const ips = uniqueIps;
  const requestWord = active === 1 ? "request" : "requests";
  const ipWord = ips === 1 ? "IP" : "IPs";
  let title: string;
  if (!live) title = "Live feed disconnected — last seen value";
  else if (active === null || ips === null) title = "Waiting for the first in-flight snapshot";
  else title = `${active} ${requestWord} executing right now from ${ips} unique client ${ipWord} — all clients combined, not a summary of the table below`;
  return (
    <span
      title={title}
      className="inline-flex items-center gap-3 text-badge text-text-secondary whitespace-nowrap"
    >
      <span
        aria-hidden="true"
        className="w-3.5 h-3.5 rounded-[50%] shrink-0"
        style={{
          background: live ? "var(--success)" : "var(--text-tertiary)",
          boxShadow: live ? "0 0 6px var(--success)" : "none",
        }}
      />
      <span className="font-mono tabular-nums font-bold text-text-primary">
        {active === null || ips === null ? "In-flight unavailable" : `${active} in flight · ${ips} ${ipWord}`}
      </span>
    </span>
  );
}

/**
 * Live in-flight count, held above the page body.
 *
 * The stream ticks whenever any request starts or finishes. Subscribing in the
 * page component itself re-rendered the whole page — every row, every chart —
 * on each tick, which is what made a busy Usage page feel heavy. The
 * subscription lives here instead and children pass through as a prop, so the
 * subtree stays referentially stable and a tick re-renders only the pill and
 * the one tile that read this context. One stream per open page.
 */
const InFlightContext = createContext<InFlightState>({ count: null, uniqueIps: null, live: false });

export function InFlightProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const state = useInFlight();
  const value = useMemo(
    () => ({ count: state.count, uniqueIps: state.uniqueIps, live: state.live }),
    [state.count, state.uniqueIps, state.live],
  );
  return <InFlightContext.Provider value={value}>{children}</InFlightContext.Provider>;
}

/** The header pill, subscribed without dragging the page into the tick. */
export function LiveInFlightPill(): ReactNode {
  const flight = useContext(InFlightContext);
  return <InFlightPill count={flight.count} uniqueIps={flight.uniqueIps} live={flight.live} />;
}

/**
 * The Requests tile. Split out because its detail line carries the live count;
 * the other tiles never change on a tick and stay in the page.
 */
export function RequestsStatCard({
  pending,
  requests,
}: {
  readonly pending: boolean;
  readonly requests: number | undefined;
}): ReactNode {
  const flight = useContext(InFlightContext);
  return (
    <StatCard
      label="Requests"
      fit
      value={pending ? "…" : formatNumber(requests)}
      detail={
        flight.count === null || flight.uniqueIps === null
          ? "In-flight unavailable"
          : `${flight.count} in flight from ${flight.uniqueIps} IPs`
      }
      icon={<Activity size={13} />}
    />
  );
}
