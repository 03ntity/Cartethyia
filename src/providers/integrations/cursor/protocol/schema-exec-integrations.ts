/**
 * Vendored from `cursor-opencode-provider` (protocol layer only).
 *
 * MIT License
 *
 * Copyright (c) 2026 Oleksiy Akimov
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import protobuf from "protobufjs"
import { addType } from "./protobuf-schema"

/**
 * Integration exec schemas: conversation search, agent-store conflict,
 * adopt, git diff, background shell spawn, hook contexts, Glob, MCP
 * exec/results, and MCP resource list/read. Third slice of the original
 * `registerExecTypes` registration order.
 */

export function registerIntegrationTypes(root: protobuf.Root): void {
addType(root, "ConversationSearchHit", [
  { id: 1, name: "conversation_id", type: "string" },
  { id: 2, name: "title", type: "string" },
  { id: 3, name: "source", type: "uint32" },
  { id: 4, name: "updated_at_ms", type: "int64" },
  { id: 5, name: "snippet", type: "string" },
])
addType(root, "ConversationSearchSuccess", [
  { id: 1, name: "hits", type: "ConversationSearchHit", repeated: true },
  { id: 2, name: "truncated", type: "bool" },
  { id: 3, name: "partial", type: "bool" },
  { id: 4, name: "rebuilding", type: "bool" },
])
addType(root, "ConversationSearchError", [
  { id: 1, name: "error", type: "string" },
])
addType(
  root,
  "ConversationSearchResult",
  [
    { id: 1, name: "success", type: "ConversationSearchSuccess" },
    { id: 2, name: "error", type: "ConversationSearchError" },
  ],
  [{ name: "result", fields: ["success", "error"] }],
)
addType(root, "AgentStoreConflictError", [
  { id: 1, name: "error", type: "string" },
])
addType(
  root,
  "AgentStoreConflictResult",
  [
    { id: 2, name: "error", type: "AgentStoreConflictError" },
  ],
  [{ name: "result", fields: ["error"] }],
)
addType(
  root,
  "AdoptResult",
  [
    { id: 1, name: "source_agent_id", type: "string" },
    { id: 2, name: "target_agent_id", type: "string" },
    { id: 3, name: "project_root_id", type: "string" },
    { id: 5, name: "error", type: "string" },
  ],
  [{ name: "result", fields: ["error"] }],
)

// aiserver.v1.GetDiffRequest / GetDiffResponse (exec #44). Enums as uint32
// so protobufjs json decode does not stringify output_format / diff_type.
addType(root, "GitDiffChunk", [
  { id: 1, name: "content", type: "string" },
  { id: 2, name: "lines", type: "string", repeated: true },
  { id: 3, name: "old_start", type: "int32" },
  { id: 4, name: "old_lines", type: "int32" },
  { id: 5, name: "new_start", type: "int32" },
  { id: 6, name: "new_lines", type: "int32" },
])
addType(root, "GitFileDiff", [
  { id: 1, name: "from", type: "string" },
  { id: 2, name: "to", type: "string" },
  { id: 3, name: "chunks", type: "GitDiffChunk", repeated: true },
  { id: 4, name: "added", type: "int32" },
  { id: 5, name: "removed", type: "int32" },
  { id: 6, name: "before_file_contents", type: "string" },
  { id: 7, name: "after_file_contents", type: "string" },
  { id: 8, name: "is_generated", type: "bool" },
])
addType(root, "GitDiff", [
  { id: 1, name: "diffs", type: "GitFileDiff", repeated: true },
  { id: 2, name: "diff_type", type: "uint32" },
])
addType(root, "GitDiffSubmoduleDiff", [
  { id: 1, name: "relative_path", type: "string" },
  { id: 2, name: "diff", type: "GitDiff" },
  { id: 3, name: "errored", type: "bool" },
])
addType(root, "GetDiffRequest", [
  { id: 1, name: "cwd", type: "string" },
  { id: 2, name: "ref", type: "string" },
  { id: 3, name: "base_ref", type: "string" },
  { id: 4, name: "merge_base", type: "bool" },
  { id: 5, name: "target_paths", type: "string", repeated: true },
  { id: 6, name: "unified_context_lines", type: "int32" },
  { id: 7, name: "max_untracked_files", type: "int32" },
  { id: 8, name: "output_format", type: "uint32" },
  { id: 9, name: "submodule_recurse_depth", type: "int32" },
  { id: 10, name: "include_space_changes", type: "bool" },
  { id: 11, name: "committed_only", type: "bool" },
  { id: 12, name: "compute_patch_id", type: "bool" },
  { id: 13, name: "return_head_sha", type: "bool" },
  { id: 14, name: "max_response_bytes", type: "int32" },
])
addType(root, "GetDiffResponse", [
  { id: 1, name: "diff", type: "GitDiff" },
  { id: 2, name: "submodule_diffs", type: "GitDiffSubmoduleDiff", repeated: true },
  { id: 3, name: "patch_id", type: "string" },
  { id: 4, name: "head_sha", type: "string" },
  { id: 5, name: "has_uncommitted_changes", type: "bool" },
])

// Cursor's non-blocking shell path is a separate exec variant from the
// foreground ShellStream above. The host only needs the fields used at the
// OpenCode boundary; protobufjs safely skips the richer classifier/approval
// messages that are private to Cursor's native client.
addType(root, "BackgroundShellSpawnArgs", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "working_directory", type: "string" },
  { id: 3, name: "tool_call_id", type: "string" },
  { id: 6, name: "enable_write_shell_stdin_tool", type: "bool" },
  { id: 7, name: "description", type: "string" },
  { id: 12, name: "skip_approval", type: "bool" },
  { id: 13, name: "conversation_id", type: "string" },
])
addType(root, "BackgroundShellSpawnSuccess", [
  { id: 1, name: "shell_id", type: "uint32" },
  { id: 2, name: "command", type: "string" },
  { id: 3, name: "working_directory", type: "string" },
  { id: 4, name: "pid", type: "uint32" },
])
addType(root, "BackgroundShellSpawnError", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "working_directory", type: "string" },
  { id: 3, name: "error", type: "string" },
])
addType(
  root,
  "BackgroundShellSpawnResult",
  [
    { id: 1, name: "success", type: "BackgroundShellSpawnSuccess" },
    { id: 2, name: "error", type: "BackgroundShellSpawnError" },
    { id: 3, name: "rejected", type: "ShellRejected" },
    { id: 4, name: "permission_denied", type: "ShellPermissionDenied" },
  ],
  [{ name: "result", fields: ["success", "error", "rejected", "permission_denied"] }],
)

// Cursor CLI postToolUse hook context: ExecClientMessage #45 on a unary
// result, ShellStream #8 on a shell stream (agent.v1 hook_additional_context).
addType(root, "HookAdditionalContext", [
  { id: 1, name: "hook_event_name", type: "string" },
  { id: 2, name: "content", type: "string" },
])
addType(root, "ShellStreamHookContext", [
  { id: 1, name: "hook_additional_contexts", type: "HookAdditionalContext", repeated: true },
])

addType(
  root,
  "ShellStream",
  [
    { id: 1, name: "stdout", type: "ShellStreamStdout" },
    { id: 2, name: "stderr", type: "ShellStreamStderr" },
    { id: 3, name: "exit", type: "ShellStreamExit" },
    { id: 4, name: "start", type: "ShellStreamStart" },
    { id: 5, name: "rejected", type: "ShellRejected" },
    { id: 6, name: "permission_denied", type: "ShellPermissionDenied" },
    { id: 7, name: "backgrounded", type: "ShellStreamBackgrounded" },
    { id: 8, name: "hook_context", type: "ShellStreamHookContext" },
  ],
  [{ name: "event", fields: ["stdout", "stderr", "exit", "start", "rejected", "permission_denied", "backgrounded", "hook_context"] }],
)

addType(root, "GlobArgs", [
  { id: 1, name: "target_directory", type: "string" },
  { id: 2, name: "glob_pattern", type: "string" },
])

addType(root, "GlobResult", [
  { id: 1, name: "files", type: "string", repeated: true },
  { id: 2, name: "error", type: "string" },
])

// `args` is a map<string, google.protobuf.Value> on the wire (repeated map
// entries at field #2). We capture each entry as raw bytes and decode them in
// tools.ts via struct.decodeStructEntriesToJson.
addType(root, "McpArgs", [
  { id: 1, name: "name", type: "string" },
  { id: 2, name: "args", type: "bytes", repeated: true },
  { id: 3, name: "tool_call_id", type: "string" },
  { id: 4, name: "provider_identifier", type: "string" },
  { id: 5, name: "tool_name", type: "string" },
])

addType(root, "McpTextContent", [{ id: 1, name: "text", type: "string" }])
// Cursor CLI 2026.10.01 `agent/v1/mcp_exec_pb.js`: "McpImageContent|1 data 12|2 mime_type 9",
// "McpToolResultContentItem|1 text #0 content|2 image #1 content".
addType(root, "McpImageContent", [
  { id: 1, name: "data", type: "bytes" },
  { id: 2, name: "mime_type", type: "string" },
])
addType(
  root,
  "McpToolResultContentItem",
  [
    { id: 1, name: "text", type: "McpTextContent" },
    { id: 2, name: "image", type: "McpImageContent" },
  ],
  [{ name: "content", fields: ["text", "image"] }],
)
addType(root, "McpRejected", [
  { id: 1, name: "reason", type: "string" },
  { id: 2, name: "is_readonly", type: "bool" },
])
addType(root, "McpPermissionDenied", [
  { id: 1, name: "error", type: "string" },
  { id: 2, name: "is_readonly", type: "bool" },
])
addType(root, "McpSuccess", [
  { id: 1, name: "content", type: "McpToolResultContentItem", repeated: true },
  { id: 2, name: "is_error", type: "bool" },
])
addType(root, "McpError", [
  { id: 1, name: "error", type: "string" },
  // Server-side CallDynamicTool validation uses a title (#1) and detail (#2).
  { id: 2, name: "detail", type: "string" },
])
addType(
  root,
  "McpResult",
  [
    { id: 1, name: "success", type: "McpSuccess" },
    { id: 2, name: "error", type: "McpError" },
    { id: 3, name: "rejected", type: "McpRejected" },
    { id: 4, name: "permission_denied", type: "McpPermissionDenied" },
  ],
  [{ name: "result", fields: ["success", "error", "rejected", "permission_denied"] }],
)

// McpToolDefinition — agent.v1 shape for RequestContext.tools (#7) and
// AgentRunRequest.mcp_tools (#4). Defined early so RequestContext* can
// reference it.
addType(root, "McpToolDefinition", [
  { id: 1, name: "name", type: "string" },
  { id: 2, name: "description", type: "string" },
  { id: 3, name: "input_schema", type: "bytes" },
  { id: 4, name: "provider_identifier", type: "string" },
  { id: 5, name: "tool_name", type: "string" },
])

// ── MCP resource exec (fields 17/18) ──
// agent.v1 ListMcpResourcesExecArgs/Result, ReadMcpResourceExecArgs/Result.
// Native Cursor exec variants: no descriptor, no advertisement, and Cursor
// may emit either unsolicited regardless of what this provider advertises
// (tasks/plans/fix-cursor-mcp-resource-exec.md, Correction 2). Under Option
// B, list_mcp_resources/read_mcp_resource execute through the ordinary
// field-11 MCP path via the alias rules below, so any 17/18 that still
// reaches this provider gets the total fallback built in tools.ts.
addType(root, "SmartModeApproval", [
  { id: 1, name: "request_id", type: "string" },
  { id: 2, name: "reason", type: "string" },
])
addType(root, "OutputLocation", [
  { id: 1, name: "file_path", type: "string" },
  { id: 2, name: "size_bytes", type: "int64" },
  { id: 3, name: "line_count", type: "int64" },
])

addType(root, "ListMcpResourcesExecArgs", [
  { id: 1, name: "server", type: "string" },
])
{
  const t = new protobuf.Type("ListMcpResourcesExecResult_McpResource")
  t.add(new protobuf.Field("uri", 1, "string"))
  t.add(new protobuf.Field("name", 2, "string"))
  t.add(new protobuf.Field("description", 3, "string"))
  t.add(new protobuf.Field("mime_type", 4, "string"))
  t.add(new protobuf.Field("server", 5, "string"))
  t.add(new protobuf.MapField("annotations", 6, "string", "string"))
  root.add(t)
}
addType(root, "ListMcpResourcesSuccess", [
  { id: 1, name: "resources", type: "ListMcpResourcesExecResult_McpResource", repeated: true },
])
addType(root, "ListMcpResourcesError", [{ id: 1, name: "error", type: "string" }])
addType(root, "ListMcpResourcesRejected", [{ id: 1, name: "reason", type: "string" }])
addType(
  root,
  "ListMcpResourcesExecResult",
  [
    { id: 1, name: "success", type: "ListMcpResourcesSuccess" },
    { id: 2, name: "error", type: "ListMcpResourcesError" },
    { id: 3, name: "rejected", type: "ListMcpResourcesRejected" },
  ],
  [{ name: "result", fields: ["success", "error", "rejected"] }],
)

addType(root, "ReadMcpResourceExecArgs", [
  { id: 1, name: "server", type: "string" },
  { id: 2, name: "uri", type: "string" },
  { id: 3, name: "download_path", type: "string" },
  { id: 4, name: "tool_call_id", type: "string" },
  { id: 5, name: "smart_mode_approval", type: "SmartModeApproval" },
])
{
  // Interleaved field order matches agent.proto exactly: the text/blob oneof
  // (5/6) sits between the shared metadata (1-4) and the trailing
  // annotations/download/output fields (7-9).
  const t = new protobuf.Type("ReadMcpResourceSuccess")
  t.add(new protobuf.Field("uri", 1, "string"))
  t.add(new protobuf.Field("name", 2, "string"))
  t.add(new protobuf.Field("description", 3, "string"))
  t.add(new protobuf.Field("mime_type", 4, "string"))
  t.add(new protobuf.Field("text", 5, "string"))
  t.add(new protobuf.Field("blob", 6, "bytes"))
  t.add(new protobuf.MapField("annotations", 7, "string", "string"))
  t.add(new protobuf.Field("download_path", 8, "string"))
  t.add(new protobuf.Field("output_location", 9, "OutputLocation"))
  t.add(new protobuf.OneOf("content", ["text", "blob"]))
  root.add(t)
}
addType(root, "ReadMcpResourceError", [
  { id: 1, name: "uri", type: "string" },
  { id: 2, name: "error", type: "string" },
])
// Cursor quirk: on `rejected` only `reason` is set — `uri` (field 1) is
// deliberately left empty. Mirror this; do not backfill uri on encode.
addType(root, "ReadMcpResourceRejected", [
  { id: 1, name: "uri", type: "string" },
  { id: 2, name: "reason", type: "string" },
])
addType(root, "ReadMcpResourceNotFound", [{ id: 1, name: "uri", type: "string" }])
addType(
  root,
  "ReadMcpResourceExecResult",
  [
    { id: 1, name: "success", type: "ReadMcpResourceSuccess" },
    { id: 2, name: "error", type: "ReadMcpResourceError" },
    { id: 3, name: "rejected", type: "ReadMcpResourceRejected" },
    { id: 4, name: "not_found", type: "ReadMcpResourceNotFound" },
  ],
  [{ name: "result", fields: ["success", "error", "rejected", "not_found"] }],
)

}
