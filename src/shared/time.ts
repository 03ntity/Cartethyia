/**
 * `YYYY-MM-DDTHH` stamp used as the prefix of raw telemetry/payload files
 * and as the hour comparison key on both sides of retention.
 */
export function hourStamp(date: Date): string {
  return date.toISOString().slice(0, 13).replaceAll(":", "-");
}
