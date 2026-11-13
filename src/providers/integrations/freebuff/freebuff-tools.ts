// Freebuff official 37-tool schema set, embedded verbatim.
//
// LOCKED: tests/provider-probing fixtures assert these bytes match the donor
// assets, so do not reformat or reorder. The tool objects live in the ordered
// freebuff-tools-chunk-*.ts modules beside this file; concatenation preserves
// the official order.
//
import type { FreebuffOfficialTool } from "./freebuff-tools-types";
import { FREEBUFF_TOOLS_CHUNK_01 } from "./freebuff-tools-chunk-01";
import { FREEBUFF_TOOLS_CHUNK_02 } from "./freebuff-tools-chunk-02";
import { FREEBUFF_TOOLS_CHUNK_03 } from "./freebuff-tools-chunk-03";
import { FREEBUFF_TOOLS_CHUNK_04 } from "./freebuff-tools-chunk-04";
import { FREEBUFF_TOOLS_CHUNK_05 } from "./freebuff-tools-chunk-05";

export type {
  FreebuffOfficialTool,
  FreebuffOfficialToolFunction,
} from "./freebuff-tools-types";

export const FREEBUFF_OFFICIAL_TOOLS: readonly FreebuffOfficialTool[] = [
  ...FREEBUFF_TOOLS_CHUNK_01,
  ...FREEBUFF_TOOLS_CHUNK_02,
  ...FREEBUFF_TOOLS_CHUNK_03,
  ...FREEBUFF_TOOLS_CHUNK_04,
  ...FREEBUFF_TOOLS_CHUNK_05,
];
