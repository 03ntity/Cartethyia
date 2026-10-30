/**
 * Whether a failed relay deploy is one the deploy form cannot recover from.
 *
 * The relay deploy authenticates to the *host* (Cloudflare, Vercel, Deno) with
 * the token the operator pasted. A rejected or expired credential surfaces as an
 * authentication error, and the console session is signed out behind it — so
 * retrying inside the form can only repeat the same failure, and the operator
 * has to sign back in first.
 *
 * Anything else is one edited field from succeeding: a taken project name, a
 * transient deploy error, an unreachable host. Those keep the form open so the
 * operator does not lose what they typed.
 *
 * Split out of the panel so the boundary is testable without mounting a dialog.
 */
export function isSessionInvalidatedError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (status === 401 || status === 403) return true;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /unauthorized|auth|forbidden/i.test(code);
}
