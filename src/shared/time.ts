/**
 * `YYYY-MM-DDTHH` stamp used as the prefix of raw telemetry/payload files
 * and as the hour comparison key on both sides of retention.
 */
export function hourStamp(date: Date): string {
  return date.toISOString().slice(0, 13);
}

/**
 * UTC calendar-day key (`YYYY-MM-DD`) shared by every once-a-day ledger:
 * the daily check-in sweep, the buddy lifecycle, and the qoder check-in all
 * bucket "did this account already run today" on the provider's own UTC day
 * boundary. One definition so a caller cannot drift onto a local-timezone or
 * differently-shaped key and silently double-claim.
 */
export function checkinDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
