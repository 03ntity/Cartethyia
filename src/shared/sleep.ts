/** Pause without holding an AbortSignal contract; callers own cancellation. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
