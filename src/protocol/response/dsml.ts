/**
 * CodeBuddy-family DeepSeek sometimes emits native tool markup as assistant text.
 * Complete declared calls are recovered; incomplete and undeclared blocks stay text.
 *
 * The mechanics live in `../dsml` with the CodeBuddy dialect as default; this
 * module keeps the historical public surface (`DsmlToolCallParser`,
 * `parseDsmlToolCalls`) stable for this wire family.
 */
import {
  DsmlStreamParser,
  type DsmlToolCall,
} from "../dsml";

export type { DsmlToolCall } from "../dsml";

export interface DsmlRecovery {
  readonly text: string;
  readonly calls: readonly DsmlToolCall[];
}

/** Streaming strict-prefix parser with the CodeBuddy dialect defaults. */
export class DsmlToolCallParser extends DsmlStreamParser {
  constructor(allowedNames: ReadonlySet<string>) {
    super({ allowedNames });
  }
}

export function parseDsmlToolCalls(
  text: string,
  allowedNames: ReadonlySet<string> = new Set(),
): DsmlRecovery | undefined {
  if (!text.includes("DSML")) return undefined;
  const parser = new DsmlToolCallParser(allowedNames);
  const first = parser.push(text);
  const last = parser.flush();
  const recovered = [...first.calls, ...last.calls];
  return recovered.length === 0 ? undefined : { text: `${first.text}${last.text}`.trim(), calls: recovered };
}
