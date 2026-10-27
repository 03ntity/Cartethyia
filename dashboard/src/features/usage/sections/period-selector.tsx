import type { ReactNode } from "react";
import { Select } from "../../../components/ui/select";
import { USAGE_PERIODS, type UsagePeriod as Period } from "../../../data/usage-periods";

const PERIOD_LABELS: Record<Period, string> = {
  "1h": "Last 1 Hour",
  "6h": "Last 6 Hours",
  "12h": "Last 12 Hours",
  "24h": "Last 24 Hours",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  all: "All retained",
};
const PERIOD_OPTIONS = USAGE_PERIODS.map((value) => ({
  value,
  label: PERIOD_LABELS[value as Period] ?? value,
}));

export function periodLabel(period: Period): string {
  return PERIOD_LABELS[period] ?? period;
}

/**
 * The usage-period picker in the Traffic card header.
 */
export function PeriodSelector({
  value,
  onChange,
}: {
  readonly value: Period;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <Select
      aria-label="Period"
      value={value}
      size="sm"
      className="w-auto min-w-46 shrink-0 grow-0 basis-auto"
      onValueChange={onChange}
      options={PERIOD_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
    />
  );
}
