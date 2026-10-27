import type { ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Button } from "../../../components/ui/button";

export function PillTabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  readonly options: ReadonlyArray<{ readonly id: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly ariaLabel: string;
}): ReactNode {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex flex-wrap gap-2 min-w-0"
    >
      {options.map((option) => (
        <Button
          key={option.id}
          role="tab"
          aria-selected={value === option.id}
          variant={value === option.id ? "primary" : "secondary"}
          size="sm"
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** Which panel a control refers to: the traffic chart or the breakdown list. */
export type PanelKey = "traffic" | "breakdown";

/**
 * Width control for one panel, rendered at the far left of the card header.
 *
 * Widening makes the panel span both grid columns — the one thing the
 * side-by-side layout cannot do on its own, for a chart or list that needs the
 * full row.
 */
export function PanelWidthToggle({
  label,
  wide,
  onToggleWide,
}: {
  readonly label: string;
  readonly wide: boolean;
  readonly onToggleWide: () => void;
}): ReactNode {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={wide ? `Restore ${label} width` : `Widen ${label}`}
      aria-pressed={wide}
      title={wide ? "Restore width" : "Widen"}
      icon={wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      onClick={onToggleWide}
    />
  );
}
