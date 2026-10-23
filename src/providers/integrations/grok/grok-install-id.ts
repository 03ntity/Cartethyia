/**
 * Grok's per-installation agent id.
 *
 * The persistence and failure handling live in the shared install-id module;
 * this file only names the id, so a failure to write it never escapes into
 * dispatch and fails the request.
 */
import { getOrCreateInstallId } from "../shared/install-id";

export function getGrokInstallId(path?: string): Promise<string> {
  return getOrCreateInstallId("grok", path);
}
