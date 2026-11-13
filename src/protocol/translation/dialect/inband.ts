/**
 * In-band tool-call scanner interface.
 *
 * Some model families emit tool calls as markup inside the text stream instead
 * of structured `tool_calls`: DeepSeek DSML blocks, Qwen tool-call JSON blocks,
 * OMP hex-marked envelopes. Each is a pluggable codec; the chat decoder selects
 * one by dialect id (see `response/chat.ts`).
 */
export interface InbandToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface InbandScanResult {
  readonly text: string;
  readonly calls: readonly InbandToolCall[];
}

export interface InbandScanner {
  push(chunk: string): InbandScanResult;
  flush(): InbandScanResult;
}
