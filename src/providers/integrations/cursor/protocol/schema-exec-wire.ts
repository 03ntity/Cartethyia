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
 * Exec wire envelopes: ExecServerMessage, ExecClientMessage, and the
 * client/server control messages (abort, stream_close, throw, heartbeat).
 * Final slice of the original `registerExecTypes` registration order.
 */

export function registerWireTypes(root: protobuf.Root): void {
// ExecServerMessage — server asks us to execute a tool
addType(
  root,
  "ExecServerMessage",
  [
    { id: 1, name: "id", type: "uint32" },
    { id: 15, name: "exec_id", type: "string" },
    { id: 19, name: "span", type: "string" },
    { id: 2, name: "shell_args", type: "ShellArgs" },
    { id: 3, name: "write_args", type: "WriteArgs" },
    { id: 4, name: "delete_args", type: "DeleteArgs" },
    { id: 5, name: "grep_args", type: "GrepArgs" },
    { id: 7, name: "read_args", type: "ReadArgs" },
    { id: 8, name: "ls_args", type: "LsArgs" },
    { id: 10, name: "request_context_args", type: "RequestContextArgs" },
    { id: 11, name: "mcp_args", type: "McpArgs" },
    { id: 14, name: "shell_stream_args", type: "ShellArgs" },
    { id: 16, name: "background_shell_spawn_args", type: "BackgroundShellSpawnArgs" },
    { id: 17, name: "list_mcp_resources_exec_args", type: "ListMcpResourcesExecArgs" },
    { id: 18, name: "read_mcp_resource_exec_args", type: "ReadMcpResourceExecArgs" },
    { id: 28, name: "subagent_args", type: "SubagentArgs" },
    { id: 36, name: "mcp_state_exec_args", type: "McpStateExecArgs" },
    { id: 41, name: "shell_allowlist_precheck_args", type: "ShellAllowlistPrecheckArgs" },
    { id: 42, name: "mcp_allowlist_precheck_args", type: "McpAllowlistPrecheckArgs" },
    { id: 43, name: "web_fetch_allowlist_precheck_args", type: "WebFetchAllowlistPrecheckArgs" },
    { id: 44, name: "git_diff_request", type: "GetDiffRequest" },
    { id: 45, name: "pi_read_args", type: "PiReadToolArgs" },
    { id: 46, name: "pi_bash_args", type: "PiBashToolArgs" },
    { id: 47, name: "pi_edit_args", type: "PiEditToolArgs" },
    { id: 48, name: "pi_write_args", type: "PiWriteArgs" },
    { id: 49, name: "pi_grep_args", type: "PiGrepToolArgs" },
    { id: 50, name: "pi_find_args", type: "PiFindToolArgs" },
    { id: 51, name: "pi_ls_args", type: "PiLsToolArgs" },
    { id: 55, name: "accept_hook_additional_contexts", type: "bool" },
  ],
  [{ name: "args", fields: [
    "shell_args", "write_args", "delete_args", "grep_args", "read_args", "ls_args",
    "request_context_args", "mcp_args", "shell_stream_args", "background_shell_spawn_args",
    "list_mcp_resources_exec_args", "read_mcp_resource_exec_args", "mcp_state_exec_args",
    "shell_allowlist_precheck_args", "mcp_allowlist_precheck_args", "web_fetch_allowlist_precheck_args",
    "subagent_args", "git_diff_request",
    "pi_read_args", "pi_bash_args", "pi_edit_args", "pi_write_args",
    "pi_grep_args", "pi_find_args", "pi_ls_args",
  ] }],
)

// ExecClientMessage — client sends tool result back
addType(
  root,
  "ExecClientMessage",
  [
    { id: 1, name: "id", type: "uint32" },
    { id: 15, name: "exec_id", type: "string" },
    { id: 39, name: "local_execution_time_ms", type: "uint64" },
    { id: 45, name: "hook_additional_contexts", type: "HookAdditionalContext", repeated: true },
    { id: 2, name: "shell_result", type: "ShellResult" },
    { id: 3, name: "write_result", type: "WriteResult" },
    { id: 4, name: "delete_result", type: "DeleteResult" },
    { id: 5, name: "grep_result", type: "GrepResult" },
    { id: 7, name: "read_result", type: "ReadResult" },
    { id: 8, name: "ls_result", type: "LsResult" },
    { id: 9, name: "diagnostics_result", type: "DiagnosticsResult" },
    { id: 10, name: "request_context_result", type: "RequestContextResult" },
    { id: 11, name: "mcp_result", type: "McpResult" },
    { id: 14, name: "shell_stream", type: "ShellStream" },
    { id: 16, name: "background_shell_spawn_result", type: "BackgroundShellSpawnResult" },
    { id: 17, name: "list_mcp_resources_exec_result", type: "ListMcpResourcesExecResult" },
    { id: 18, name: "read_mcp_resource_exec_result", type: "ReadMcpResourceExecResult" },
    { id: 20, name: "fetch_result", type: "FetchResult" },
    { id: 21, name: "record_screen_result", type: "RecordScreenResult" },
    { id: 22, name: "computer_use_result", type: "ComputerUseResult" },
    { id: 23, name: "write_shell_stdin_result", type: "WriteShellStdinResult" },
    { id: 28, name: "subagent_result", type: "SubagentResult" },
    { id: 29, name: "redacted_read_result", type: "ReadResult" },
    { id: 30, name: "force_background_shell_result", type: "ForceBackgroundShellResult" },
    { id: 31, name: "force_background_subagent_result", type: "ForceBackgroundSubagentResult" },
    { id: 36, name: "mcp_state_exec_result", type: "McpStateExecResult" },
    { id: 37, name: "subagent_await_result", type: "SubagentAwaitResult" },
    { id: 38, name: "smart_mode_classifier_result", type: "SmartModeClassifierResult" },
    { id: 40, name: "canvas_diagnostics_result", type: "CanvasDiagnosticsResult" },
    { id: 41, name: "shell_allowlist_precheck_result", type: "ShellAllowlistPrecheckResult" },
    { id: 42, name: "mcp_allowlist_precheck_result", type: "McpAllowlistPrecheckResult" },
    { id: 43, name: "web_fetch_allowlist_precheck_result", type: "WebFetchAllowlistPrecheckResult" },
    { id: 44, name: "git_diff_response", type: "GetDiffResponse" },
    { id: 46, name: "pi_read_result", type: "PiReadExecResult" },
    { id: 47, name: "pi_bash_result", type: "PiBashExecResult" },
    { id: 48, name: "pi_edit_result", type: "PiEditExecResult" },
    { id: 49, name: "pi_write_result", type: "PiWriteResult" },
    { id: 50, name: "pi_grep_result", type: "PiGrepExecResult" },
    { id: 51, name: "pi_find_result", type: "PiFindExecResult" },
    { id: 52, name: "pi_ls_result", type: "PiLsExecResult" },
    { id: 53, name: "conversation_search_result", type: "ConversationSearchResult" },
    { id: 54, name: "agent_store_conflict_result", type: "AgentStoreConflictResult" },
    { id: 55, name: "mini_swe_agent_bash_result", type: "ShellResult" },
    { id: 56, name: "adopt_result", type: "AdoptResult" },
  ],
  [{ name: "result", fields: [
    "shell_result", "write_result", "delete_result", "grep_result", "read_result", "ls_result",
    "diagnostics_result", "request_context_result", "mcp_result", "shell_stream", "background_shell_spawn_result",
    "list_mcp_resources_exec_result", "read_mcp_resource_exec_result",
    "fetch_result", "record_screen_result", "computer_use_result", "write_shell_stdin_result",
    "subagent_result", "redacted_read_result",
    "force_background_shell_result", "force_background_subagent_result",
    "mcp_state_exec_result",
    "subagent_await_result", "smart_mode_classifier_result", "canvas_diagnostics_result",
    "shell_allowlist_precheck_result", "mcp_allowlist_precheck_result", "web_fetch_allowlist_precheck_result",
    "git_diff_response",
    "pi_read_result", "pi_bash_result", "pi_edit_result", "pi_write_result",
    "pi_grep_result", "pi_find_result", "pi_ls_result",
    "conversation_search_result", "agent_store_conflict_result",
    "mini_swe_agent_bash_result", "adopt_result",
  ] }],
)

addType(root, "ExecServerControlMessage", [
  { id: 1, name: "abort", type: "ExecServerAbort" },
])

addType(root, "ExecServerAbort", [
  { id: 1, name: "id", type: "uint32" },
])

// Client→server control (ACM #5). Distinct from ExecServerControlMessage (ASM #5).
// After every exec result (especially multi-frame shell_stream), the real CLI
// sends stream_close{id} — without it the cloud waits forever on shell execs.
addType(root, "ExecClientStreamClose", [{ id: 1, name: "id", type: "uint32" }])
addType(root, "ExecClientThrow", [
  { id: 1, name: "id", type: "uint32" },
  { id: 2, name: "error", type: "string" },
])
addType(root, "ExecClientHeartbeat", [{ id: 1, name: "id", type: "uint32" }])
addType(
  root,
  "ExecClientControlMessage",
  [
    { id: 1, name: "stream_close", type: "ExecClientStreamClose" },
    { id: 2, name: "throw", type: "ExecClientThrow" },
    { id: 3, name: "heartbeat", type: "ExecClientHeartbeat" },
  ],
  [{ name: "message", fields: ["stream_close", "throw", "heartbeat"] }],
)

}
