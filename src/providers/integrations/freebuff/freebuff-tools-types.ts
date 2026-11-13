// Shared types for the Freebuff official tool schema chunks.
//
export interface FreebuffOfficialToolFunction {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
}
export interface FreebuffOfficialTool {
  readonly type: "function";
  readonly function: FreebuffOfficialToolFunction;
}
