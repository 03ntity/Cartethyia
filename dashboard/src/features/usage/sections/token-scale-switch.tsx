import type { ReactNode } from "react";
import { Scaling } from "lucide-react";
import {
  RAW_TOKEN_SCALE,
  TOKEN_SCALE_AUTO,
  TOKEN_SCALES,
  tokenScaleIndex,
} from "../../../lib/format/tokens";

/**
 * Scale switcher on a token card. Cards start on the exact count; each click
 * steps through the compact units from the coarsest that fits down to K and
 * then wraps back to the exact count, so the raw number and the readable
 * abbreviated form are both one click away with no dead end. Hidden when the
 * value is so small that no unit would compress it.
 */
export function TokenScaleSwitch({
  label,
  value,
  scale,
  onChange,
}: {
  label: string;
  value: number | null | undefined;
  scale: number;
  onChange: (next: number) => void;
}): ReactNode {
  const auto =
    value === null || value === undefined || !Number.isFinite(value)
      ? null
      : tokenScaleIndex(value);
  if (auto === null || auto >= RAW_TOKEN_SCALE) return null;
  const next =
    scale === TOKEN_SCALE_AUTO
      ? Math.min(auto + 1, RAW_TOKEN_SCALE)
      : scale >= RAW_TOKEN_SCALE
        ? TOKEN_SCALE_AUTO
        : scale + 1;
  const currentName =
    scale === TOKEN_SCALE_AUTO
      ? TOKEN_SCALES[auto]?.suffix ?? "raw"
      : scale >= RAW_TOKEN_SCALE
        ? "raw"
        : TOKEN_SCALES[scale]?.suffix ?? "raw";
  const nextName =
    next === TOKEN_SCALE_AUTO
      ? "default unit"
      : next >= RAW_TOKEN_SCALE
        ? "exact count"
        : TOKEN_SCALES[next]?.suffix;
  return (
    <button
      type="button"
      aria-label={`${label}: currently ${currentName}, switch to ${nextName}`}
      title={`Show ${nextName}`}
      onClick={() => onChange(next)}
      className="font-mono tabular-nums inline-flex items-center gap-2 px-3.5 py-1.5 border border-inner-border rounded-pill bg-surface-2 text-text-secondary cursor-pointer text-micro font-bold tracking-[0.04em] leading-[1]"
    >
      <Scaling size={11} aria-hidden="true" />
      {currentName}
    </button>
  );
}
