/**
 * The ban durations the dashboard offers, and the one a bare click uses.
 *
 * Mirrored from the server's own list rather than declared twice: the route
 * rejects a duration it does not offer, so a choice the UI showed but the API
 * refused would be a button that always fails. `minutes: null` is the
 * "Permanent" choice.
 *
 * The dashboard cannot import from `src/` (it must stay browser-safe), so this
 * is the one place the two lists are kept apart. The backend's list is the
 * authority; this file exists so the copy cannot drift *within* the dashboard
 * between the request-detail menu and the ban list's labels.
 */
export interface BanDurationChoice {
  /** Whole minutes, or `null` for permanent. */
  readonly minutes: number | null;
  readonly label: string;
}

export const BAN_DURATION_CHOICES: readonly BanDurationChoice[] = [
  { minutes: 60, label: "1 hour" },
  { minutes: 6 * 60, label: "6 hours" },
  { minutes: 12 * 60, label: "12 hours" },
  { minutes: 24 * 60, label: "1 day" },
  { minutes: 7 * 24 * 60, label: "7 days" },
  { minutes: null, label: "Permanent" },
];

/** What a bare "Banned User" click does: the shortest, most reversible choice. */
export const DEFAULT_BAN_CHOICE: BanDurationChoice = BAN_DURATION_CHOICES[0]!;

/**
 * Human wording for how long a ban lasts, for the list and for toasts.
 *
 * "Permanent" is spelled out rather than rendered as a countdown: a ban that
 * will not lift on its own is a different decision for the operator to review,
 * and "in 50y" would read as a bug.
 */
export function banDurationLabel(minutes: number | null): string {
  if (minutes === null) return "Permanent";
  const found = BAN_DURATION_CHOICES.find((choice) => choice.minutes === minutes);
  return found?.label ?? `${minutes} min`;
}
