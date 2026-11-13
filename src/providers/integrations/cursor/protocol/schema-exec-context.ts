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
 * Request-context probe schemas: RequestContextArgs/Env/rules/repository/
 * skill payload types, RequestContextPayload/Result, allowlist precheck
 * args, and the MCP state probe. Fourth slice of the original
 * `registerExecTypes` registration order.
 */

export function registerContextTypes(root: protobuf.Root): void {
// ── request_context (#10): server-initiated setup probe ──
// At the start of an agent turn the server sends ExecServerMessage
// {request_context_args} to ask the client for workspace/env/tool context.
// The reply is ExecClientMessage {request_context_result{success{request_context}}}.
// If we don't reply, the server blocks on heartbeats forever (the "times out,
// no response" symptom). We populate a minimal-but-real RequestContext — env
// (workspace/shell/os) plus the tool list echoed into #7 tools (same
// McpToolDefinition shape as AgentRunRequest #4 mcp_tools) so the model keeps
// the tools opencode advertised.
addType(root, "RequestContextArgs", [
  { id: 2, name: "notes_session_id", type: "string" },
  { id: 3, name: "workspace_id", type: "string" },
  { id: 7, name: "use_cached", type: "bool" },
])

addType(root, "RequestContextEnv", [
  { id: 1, name: "os_version", type: "string" },
  { id: 2, name: "workspace_paths", type: "string", repeated: true },
  { id: 3, name: "shell", type: "string" },
  { id: 5, name: "sandbox_enabled", type: "bool" },
  { id: 7, name: "terminals_folder", type: "string" },
  { id: 10, name: "time_zone", type: "string" },
  { id: 11, name: "project_folder", type: "string" },
  { id: 12, name: "agent_transcripts_folder", type: "string" },
  { id: 14, name: "sandbox_supported", type: "bool" },
  { id: 20, name: "is_working_dir_home_dir", type: "bool" },
  { id: 21, name: "process_working_directory", type: "string" },
])

// Cursor applies a rule by its type: `global` is the CLI's `alwaysApply: true`
// (its AGENTS.md / CLAUDE.md default). An untyped rule is only attachable on
// request, so its content never reaches the model on its own.
addType(root, "CursorRuleTypeGlobal", [])
addType(root, "CursorRuleTypeFileGlobs", [
  { id: 1, name: "globs", type: "string", repeated: true },
])
addType(root, "CursorRuleTypeAgentFetched", [
  { id: 1, name: "description", type: "string" },
])
addType(root, "CursorRuleTypeManuallyAttached", [])
addType(root, "CursorRuleType", [
  { id: 1, name: "global", type: "CursorRuleTypeGlobal" },
  { id: 2, name: "file_globbed", type: "CursorRuleTypeFileGlobs" },
  { id: 3, name: "agent_fetched", type: "CursorRuleTypeAgentFetched" },
  { id: 4, name: "manually_attached", type: "CursorRuleTypeManuallyAttached" },
], [{ name: "type", fields: ["global", "file_globbed", "agent_fetched", "manually_attached"] }])
addType(root, "CursorRule", [
  { id: 1, name: "full_path", type: "string" },
  { id: 2, name: "content", type: "string" },
  { id: 3, name: "type", type: "CursorRuleType" },
])

addType(root, "RepositoryIndexingInfo", [
  { id: 1, name: "relative_workspace_path", type: "string" },
  { id: 2, name: "remote_urls", type: "string", repeated: true },
  { id: 3, name: "remote_names", type: "string", repeated: true },
  { id: 4, name: "repo_name", type: "string" },
  { id: 5, name: "repo_owner", type: "string" },
  { id: 6, name: "is_tracked", type: "bool" },
  { id: 7, name: "is_local", type: "bool" },
  { id: 9, name: "workspace_uri", type: "string" },
])

addType(root, "GitRepoInfo", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "status", type: "string" },
  { id: 3, name: "branch_name", type: "string" },
  { id: 4, name: "remote_url", type: "string" },
])

addType(root, "AgentSkill", [
  { id: 1, name: "full_path", type: "string" },
  { id: 2, name: "content", type: "string" },
  { id: 3, name: "description", type: "string" },
])

addType(root, "CustomSubagent", [
  { id: 1, name: "full_path", type: "string" },
  { id: 2, name: "name", type: "string" },
  { id: 3, name: "description", type: "string" },
  { id: 6, name: "prompt", type: "string" },
])

// Nested MCP filesystem / meta-tool shapes (agent.v1). Must be defined
// before RequestContextPayload / RequestContext reference them.
addType(root, "McpFsToolDescriptor", [
  { id: 1, name: "tool_name", type: "string" },
  { id: 3, name: "description", type: "string" },
  { id: 4, name: "input_schema", type: "bytes" },
])

addType(root, "McpDescriptor", [
  { id: 1, name: "server_name", type: "string" },
  { id: 2, name: "server_identifier", type: "string" },
  { id: 5, name: "tools", type: "McpFsToolDescriptor", repeated: true },
])

addType(root, "McpFileSystemOptions", [
  { id: 1, name: "enabled", type: "bool" },
  { id: 2, name: "workspace_project_dir", type: "string" },
  { id: 3, name: "mcp_descriptors", type: "McpDescriptor", repeated: true },
])

addType(root, "McpMetaToolOptions", [
  { id: 1, name: "enabled", type: "bool" },
  { id: 2, name: "mcp_descriptors", type: "McpDescriptor", repeated: true },
])

addType(root, "PermissionsAutoRunInstructions", [
  { id: 1, name: "allow_instructions", type: "string", repeated: true },
  { id: 2, name: "block_instructions", type: "string", repeated: true },
])

addType(root, "RequestContextPayload", [
  { id: 2, name: "rules", type: "CursorRule", repeated: true },
  { id: 4, name: "env", type: "RequestContextEnv" },
  { id: 6, name: "repository_info", type: "RepositoryIndexingInfo", repeated: true },
  { id: 7, name: "tools", type: "McpToolDefinition", repeated: true },
  { id: 11, name: "git_repos", type: "GitRepoInfo", repeated: true },
  { id: 13, name: "project_layouts", type: "LsDirectoryTreeNode", repeated: true },
  { id: 17, name: "web_search_enabled", type: "bool" },
  { id: 22, name: "custom_subagents", type: "CustomSubagent", repeated: true },
  { id: 23, name: "mcp_file_system_options", type: "McpFileSystemOptions" },
  { id: 24, name: "web_fetch_enabled", type: "bool" },
  { id: 25, name: "hooks_additional_context", type: "string" },
  { id: 29, name: "agent_skills", type: "AgentSkill", repeated: true },
  { id: 33, name: "git_repo_info_complete", type: "bool" },
  { id: 34, name: "mcp_meta_tool_options", type: "McpMetaToolOptions" },
  { id: 36, name: "mcp_info_complete", type: "bool" },
  { id: 39, name: "rules_info_complete", type: "bool" },
  { id: 40, name: "env_info_complete", type: "bool" },
  { id: 41, name: "repository_info_complete", type: "bool" },
  { id: 42, name: "custom_subagents_info_complete", type: "bool" },
  { id: 43, name: "agent_skills_info_complete", type: "bool" },
  { id: 44, name: "mcp_file_system_info_complete", type: "bool" },
  { id: 45, name: "git_status_info_complete", type: "bool" },
  { id: 46, name: "user_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
  { id: 47, name: "project_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
])

addType(root, "RequestContextSuccess", [
  { id: 1, name: "request_context", type: "RequestContextPayload" },
])

// Allowlist prechecks (exec #41/#42/#43): Cursor asks whether a shell
// command / MCP tool / web fetch would be permitted before it emits the
// real call. Without an args frame this is decodable, but its exec id is
// then stranded — the server waits forever for the matching result.
addType(root, "ShellAllowlistPrecheckArgs", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "working_directory", type: "string" },
  { id: 3, name: "parsing_result", type: "bytes" },
  { id: 4, name: "classifier_result", type: "bytes" },
  { id: 5, name: "tool_call_id", type: "string" },
])
addType(root, "McpAllowlistPrecheckArgs", [
  { id: 1, name: "provider_identifier", type: "string" },
  { id: 2, name: "tool_name", type: "string" },
  { id: 3, name: "tool_call_id", type: "string" },
])
addType(root, "WebFetchAllowlistPrecheckArgs", [
  { id: 1, name: "url", type: "string" },
  { id: 2, name: "tool_call_id", type: "string" },
])

addType(root, "RequestContextResult", [
  { id: 1, name: "success", type: "RequestContextSuccess" },
])

// Cursor probes MCP server availability before emitting an MCP-backed tool
// call. OpenCode owns those servers, so answer from the live host catalog
// rather than surfacing this as a user tool.
addType(root, "McpStateExecArgs", [
  { id: 1, name: "server_identifiers", type: "string", repeated: true },
  { id: 2, name: "kick_only", type: "bool" },
])
addType(root, "McpInstructions", [
  { id: 1, name: "server_name", type: "string" },
  { id: 2, name: "instructions", type: "string" },
  { id: 3, name: "server_identifier", type: "string" },
])
addType(root, "McpStateServer", [
  { id: 1, name: "server_name", type: "string" },
  { id: 2, name: "server_identifier", type: "string" },
  { id: 3, name: "plugin", type: "string" },
  { id: 4, name: "marketplace", type: "string" },
  // Unlike McpDescriptor (#23/#34), exec #36 returns the full canonical
  // McpToolDefinition shape, including composite name and provider identity.
  { id: 5, name: "tools", type: "McpToolDefinition", repeated: true },
  { id: 6, name: "instructions", type: "McpInstructions", repeated: true },
  { id: 7, name: "status", type: "string" },
])
addType(root, "McpStateSuccess", [
  { id: 1, name: "servers", type: "McpStateServer", repeated: true },
])
addType(root, "McpStateError", [{ id: 1, name: "error", type: "string" }])
addType(root, "McpStateRejected", [{ id: 1, name: "reason", type: "string" }])
addType(
  root,
  "McpStateExecResult",
  [
    { id: 1, name: "success", type: "McpStateSuccess" },
    { id: 2, name: "error", type: "McpStateError" },
    { id: 3, name: "rejected", type: "McpStateRejected" },
  ],
  [{ name: "result", fields: ["success", "error", "rejected"] }],
)

}
