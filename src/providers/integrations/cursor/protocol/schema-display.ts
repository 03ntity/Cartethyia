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
 * Utility and display-tool-call schema: InteractionUpdate payload types and
 * every `agent.v1.ToolCall` display variant.
 */

export function registerDisplayTypes(root: protobuf.Root): void {
// ── Utility messages ──


addType(root, "TextDeltaUpdate", [
  { id: 1, name: "text", type: "string" },
])

addType(root, "ThinkingDeltaUpdate", [
  { id: 1, name: "text", type: "string" },
])

addType(root, "TurnEnded", [
  { id: 1, name: "input_tokens", type: "uint32" },
  { id: 2, name: "output_tokens", type: "uint32" },
  { id: 3, name: "cache_read", type: "uint32" },
  { id: 4, name: "cache_write", type: "uint32" },
  { id: 5, name: "reasoning_tokens", type: "uint32" },
])

addType(root, "Heartbeat", [])

// Display ToolCall (interaction_update.tool_call_*) — agent.v1 oneof, not
// {tool_name,args} strings. Decode finalized todo state for mirroring and
// MCP errors for diagnostics; other completion results are not replayed.
root.add(new protobuf.Enum("TodoStatus", {
  TODO_STATUS_UNSPECIFIED: 0,
  TODO_STATUS_PENDING: 1,
  TODO_STATUS_IN_PROGRESS: 2,
  TODO_STATUS_COMPLETED: 3,
  TODO_STATUS_CANCELLED: 4,
}))
addType(root, "TodoItem", [
  { id: 1, name: "id", type: "string" },
  { id: 2, name: "content", type: "string" },
  { id: 3, name: "status", type: "TodoStatus" },
  { id: 4, name: "created_at", type: "int64" },
  { id: 5, name: "updated_at", type: "int64" },
  { id: 6, name: "dependencies", type: "string", repeated: true },
])
addType(root, "UpdateTodosArgs", [
  { id: 1, name: "todos", type: "TodoItem", repeated: true },
  { id: 2, name: "merge", type: "bool" },
])
addType(root, "UpdateTodosSuccess", [
  { id: 1, name: "todos", type: "TodoItem", repeated: true },
  { id: 2, name: "total_count", type: "int32" },
  { id: 3, name: "was_merge", type: "bool" },
])
addType(root, "UpdateTodosError", [{ id: 1, name: "error", type: "string" }])
addType(
  root,
  "UpdateTodosResult",
  [
    { id: 1, name: "success", type: "UpdateTodosSuccess" },
    { id: 2, name: "error", type: "UpdateTodosError" },
  ],
  [{ name: "result", fields: ["success", "error"] }],
)
addType(root, "UpdateTodosToolCall", [
  { id: 1, name: "args", type: "UpdateTodosArgs" },
  { id: 2, name: "result", type: "UpdateTodosResult" },
])
addType(root, "ReadToolArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "offset", type: "int32" },
  { id: 3, name: "limit", type: "int32" },
])
addType(root, "ReadToolCall", [{ id: 1, name: "args", type: "ReadToolArgs" }])
addType(root, "ShellToolCall", [{ id: 1, name: "args", type: "ShellArgs" }])
addType(root, "DeleteToolCall", [{ id: 1, name: "args", type: "DeleteArgs" }])
addType(root, "GlobToolCall", [{ id: 1, name: "args", type: "GlobArgs" }])
addType(root, "GrepToolCall", [{ id: 1, name: "args", type: "GrepArgs" }])
addType(root, "EditToolArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 6, name: "stream_content", type: "string" },
])
addType(root, "EditToolCall", [{ id: 1, name: "args", type: "EditToolArgs" }])
addType(root, "LsToolCall", [{ id: 1, name: "args", type: "LsArgs" }])
addType(root, "McpToolCall", [
  { id: 1, name: "args", type: "McpArgs" },
  { id: 2, name: "result", type: "McpResult" },
])
addType(root, "CreatePlanArgs", [
  { id: 1, name: "plan", type: "string" },
  { id: 2, name: "todos", type: "TodoItem", repeated: true },
  { id: 3, name: "overview", type: "string" },
  { id: 4, name: "name", type: "string" },
  { id: 5, name: "is_project", type: "bool" },
])
addType(root, "CreatePlanToolCall", [{ id: 1, name: "args", type: "CreatePlanArgs" }])
addType(root, "WebSearchToolArgs", [
  { id: 1, name: "search_term", type: "string" },
  { id: 2, name: "tool_call_id", type: "string" },
])
addType(root, "WebSearchToolCall", [{ id: 1, name: "args", type: "WebSearchToolArgs" }])
addType(root, "SubagentTypeUnspecified", [])
addType(root, "SubagentTypeComputerUse", [])
addType(root, "SubagentTypeCustom", [{ id: 1, name: "name", type: "string" }])
addType(root, "SubagentTypeExplore", [])
addType(root, "SubagentTypeMediaReview", [])
addType(root, "SubagentTypeBash", [])
addType(root, "SubagentTypeBrowserUse", [])
addType(root, "SubagentTypeShell", [])
addType(root, "SubagentTypeVmSetupHelper", [])
addType(root, "SubagentTypeDebug", [])
addType(root, "SubagentTypeCursorGuide", [])
addType(root, "SubagentTypeWatchVideo", [])
addType(
  root,
  "SubagentType",
  [
    { id: 1, name: "unspecified", type: "SubagentTypeUnspecified" },
    { id: 2, name: "computer_use", type: "SubagentTypeComputerUse" },
    { id: 3, name: "custom", type: "SubagentTypeCustom" },
    { id: 4, name: "explore", type: "SubagentTypeExplore" },
    { id: 5, name: "media_review", type: "SubagentTypeMediaReview" },
    { id: 6, name: "bash", type: "SubagentTypeBash" },
    { id: 7, name: "browser_use", type: "SubagentTypeBrowserUse" },
    { id: 8, name: "shell", type: "SubagentTypeShell" },
    { id: 9, name: "vm_setup_helper", type: "SubagentTypeVmSetupHelper" },
    { id: 10, name: "debug", type: "SubagentTypeDebug" },
    { id: 11, name: "cursor_guide", type: "SubagentTypeCursorGuide" },
    { id: 12, name: "watch_video", type: "SubagentTypeWatchVideo" },
  ],
  [{
    name: "type",
    fields: [
      "unspecified", "computer_use", "custom", "explore", "media_review", "bash",
      "browser_use", "shell", "vm_setup_helper", "debug", "cursor_guide", "watch_video",
    ],
  }],
)
addType(root, "TaskToolArgs", [
  { id: 1, name: "description", type: "string" },
  { id: 2, name: "prompt", type: "string" },
  { id: 3, name: "subagent_type", type: "SubagentType" },
  { id: 4, name: "model", type: "string" },
  { id: 5, name: "resume", type: "string" },
  { id: 6, name: "agent_id", type: "string" },
  { id: 7, name: "attachments", type: "string", repeated: true },
])
addType(root, "TaskToolCall", [{ id: 1, name: "args", type: "TaskToolArgs" }])

// Native subagent execution is separate from the display-only TaskToolCall.
// Cursor asks the local client to run the task through ExecServerMessage #28
// and waits for the correlated SubagentResult at ExecClientMessage #28.
addType(root, "SubagentArgs", [
  { id: 1, name: "tool_call_id", type: "string" },
  { id: 2, name: "subagent_type", type: "string" },
  { id: 3, name: "model_id", type: "string" },
  { id: 4, name: "prompt", type: "string" },
  { id: 5, name: "readonly", type: "bool" },
  { id: 6, name: "resume_agent_id", type: "string" },
  { id: 7, name: "run_in_background", type: "bool" },
])
addType(root, "SubagentSuccess", [
  { id: 1, name: "agent_id", type: "string" },
  { id: 2, name: "final_message", type: "string" },
  { id: 3, name: "tool_call_count", type: "int32" },
  { id: 4, name: "background_reason", type: "int32" },
  { id: 5, name: "transcript_path", type: "string" },
])
addType(root, "SubagentError", [
  { id: 1, name: "agent_id", type: "string" },
  { id: 2, name: "error", type: "string" },
])
addType(
  root,
  "SubagentResult",
  [
    { id: 1, name: "success", type: "SubagentSuccess" },
    { id: 2, name: "error", type: "SubagentError" },
  ],
  [{ name: "result", fields: ["success", "error"] }],
)
addType(root, "AskQuestionOption", [
  { id: 1, name: "id", type: "string" },
  { id: 2, name: "label", type: "string" },
])
addType(root, "AskQuestionItem", [
  { id: 1, name: "id", type: "string" },
  { id: 2, name: "prompt", type: "string" },
  { id: 3, name: "options", type: "AskQuestionOption", repeated: true },
  { id: 4, name: "allow_multiple", type: "bool" },
])
addType(root, "AskQuestionArgs", [
  { id: 1, name: "title", type: "string" },
  { id: 2, name: "questions", type: "AskQuestionItem", repeated: true },
  // #5/#6 drive Cursor's non-blocking AskQuestion: the client answers the
  // interaction with `async` right away and delivers the real answers later
  // through ConversationAction.async_ask_question_completion_action, keyed by
  // the originating tool call id. See protocol/ask-question.ts.
  { id: 5, name: "run_async", type: "bool" },
  { id: 6, name: "async_original_tool_call_id", type: "string" },
])
addType(root, "AskQuestionToolCall", [{ id: 1, name: "args", type: "AskQuestionArgs" }])
addType(root, "FetchToolArgs", [
  { id: 1, name: "url", type: "string" },
  { id: 2, name: "tool_call_id", type: "string" },
])
addType(root, "FetchToolCall", [{ id: 1, name: "args", type: "FetchToolArgs" }])
addType(root, "WebFetchToolCall", [{ id: 1, name: "args", type: "FetchToolArgs" }])
addType(root, "SwitchModeToolArgs", [
  { id: 1, name: "target_mode_id", type: "string" },
  { id: 2, name: "explanation", type: "string" },
  { id: 3, name: "tool_call_id", type: "string" },
])
// Display ToolCall.result (CLI success hardcodes from_mode_id=""); distinct from
// InteractionResponse approved/rejected, which is the consent gate.
addType(root, "SwitchModeSuccess", [
  { id: 1, name: "from_mode_id", type: "string" },
  { id: 2, name: "to_mode_id", type: "string" },
])
addType(root, "SwitchModeError", [{ id: 1, name: "error", type: "string" }])
addType(root, "SwitchModeRejected", [{ id: 1, name: "reason", type: "string" }])
addType(root, "SwitchModeResult", [
  { id: 1, name: "success", type: "SwitchModeSuccess" },
  { id: 2, name: "error", type: "SwitchModeError" },
  { id: 3, name: "rejected", type: "SwitchModeRejected" },
], [{ name: "result", fields: ["success", "error", "rejected"] }])
addType(root, "SwitchModeToolCall", [
  { id: 1, name: "args", type: "SwitchModeToolArgs" },
  { id: 2, name: "result", type: "SwitchModeResult" },
])
addType(root, "PiReadToolArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "offset", type: "int32" },
  { id: 3, name: "limit", type: "int32" },
])
addType(root, "PiBashToolArgs", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "timeout", type: "double" },
])
addType(root, "PiEditReplacement", [
  { id: 1, name: "old_text", type: "string" },
  { id: 2, name: "new_text", type: "string" },
])
addType(root, "PiEditToolArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "edits", type: "PiEditReplacement", repeated: true },
])
addType(root, "PiWriteToolArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "content", type: "string" },
])
addType(root, "PiGrepToolArgs", [
  { id: 1, name: "pattern", type: "string" },
  { id: 2, name: "path", type: "string" },
  { id: 3, name: "glob", type: "string" },
  { id: 4, name: "ignore_case", type: "bool" },
  { id: 5, name: "literal", type: "bool" },
  { id: 6, name: "context", type: "int32" },
  { id: 7, name: "limit", type: "int32" },
])
addType(root, "PiFindToolArgs", [
  { id: 1, name: "pattern", type: "string" },
  { id: 2, name: "path", type: "string" },
  { id: 3, name: "limit", type: "int32" },
])
addType(root, "PiLsToolArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "limit", type: "int32" },
])
addType(root, "PiWriteToolCall", [{ id: 1, name: "args", type: "PiWriteToolArgs" }])
addType(root, "PiReadToolCall", [{ id: 1, name: "args", type: "PiReadToolArgs" }])
addType(root, "PiBashToolCall", [{ id: 1, name: "args", type: "PiBashToolArgs" }])
addType(root, "PiEditToolCall", [{ id: 1, name: "args", type: "PiEditToolArgs" }])
addType(root, "PiGrepToolCall", [{ id: 1, name: "args", type: "PiGrepToolArgs" }])
addType(root, "PiFindToolCall", [{ id: 1, name: "args", type: "PiFindToolArgs" }])
addType(root, "PiLsToolCall", [{ id: 1, name: "args", type: "PiLsToolArgs" }])
// Display-only native tools Cursor may complete without an ExecServerMessage.
// ReadTodos mirrors UpdateTodos: args + result (see agent.v1 ReadTodosToolCall).
addType(root, "ReadTodosArgs", [
  { id: 1, name: "status_filter", type: "TodoStatus", repeated: true },
  { id: 2, name: "id_filter", type: "string", repeated: true },
])
addType(root, "ReadTodosSuccess", [
  { id: 1, name: "todos", type: "TodoItem", repeated: true },
  { id: 2, name: "total_count", type: "int32" },
])
addType(root, "ReadTodosError", [{ id: 1, name: "error", type: "string" }])
addType(
  root,
  "ReadTodosResult",
  [
    { id: 1, name: "success", type: "ReadTodosSuccess" },
    { id: 2, name: "error", type: "ReadTodosError" },
  ],
  [{ name: "result", fields: ["success", "error"] }],
)
addType(root, "ReadTodosToolCall", [
  { id: 1, name: "args", type: "ReadTodosArgs" },
  { id: 2, name: "result", type: "ReadTodosResult" },
])
addType(root, "AwaitArgs", [
  { id: 1, name: "task_id", type: "string" },
  { id: 2, name: "block_until_ms", type: "uint32" },
  { id: 3, name: "regex", type: "string" },
])
addType(root, "AwaitToolCall", [{ id: 1, name: "args", type: "AwaitArgs" }])
addType(root, "GetMcpToolsArgs", [
  { id: 1, name: "server", type: "string" },
  { id: 2, name: "tool_name", type: "string" },
  { id: 3, name: "pattern", type: "string" },
  { id: 4, name: "tool_call_id", type: "string" },
])
// agent.v1 GetMcpToolsToolCall is args + result. Cursor's agent fills result
// locally (GetDynamicTools / GetMcpTools); large catalogs spill through
// write_args and put the spill path on GetMcpToolsSuccess.output_file_path.
addType(root, "GetMcpToolsSuccess", [
  { id: 1, name: "content", type: "string" },
  { id: 2, name: "output_file_path", type: "string" },
])
addType(root, "GetMcpToolsError", [{ id: 1, name: "error", type: "string" }])
addType(root, "GetMcpToolsAgentResult", [
  { id: 1, name: "success", type: "GetMcpToolsSuccess" },
  { id: 2, name: "error", type: "GetMcpToolsError" },
], [{ name: "result", fields: ["success", "error"] }])
addType(root, "GetMcpToolsToolCall", [
  { id: 1, name: "args", type: "GetMcpToolsArgs" },
  { id: 2, name: "result", type: "GetMcpToolsAgentResult" },
])

addType(root, "GenerateImageToolArgs", [
  { id: 1, name: "description", type: "string" },
  { id: 2, name: "file_path", type: "string" },
  { id: 5, name: "reference_image_paths", type: "string", repeated: true },
])
// Cursor generates the image server-side and returns it on the display
// tool_call frame. `image_data` is a base64 string, not bytes.
addType(root, "GenerateImageSuccess", [
  { id: 1, name: "file_path", type: "string" },
  { id: 2, name: "image_data", type: "string" },
])
addType(root, "GenerateImageError", [{ id: 1, name: "error", type: "string" }])
addType(root, "GenerateImageResult", [
  { id: 1, name: "success", type: "GenerateImageSuccess" },
  { id: 2, name: "error", type: "GenerateImageError" },
], [{ name: "result", fields: ["success", "error"] }])
addType(root, "GenerateImageToolCall", [
  { id: 1, name: "args", type: "GenerateImageToolArgs" },
  { id: 2, name: "result", type: "GenerateImageResult" },
])
// InteractionQuery keeps query bodies opaque; decoded on demand like
// AskQuestionInteractionQuery.
addType(root, "GenerateImageRequestQuery", [
  { id: 1, name: "args", type: "GenerateImageToolArgs" },
  { id: 2, name: "tool_call_id", type: "string" },
])

addType(
  root,
  "ToolCall",
  [
    { id: 57, name: "tool_call_id", type: "string" },
    { id: 1, name: "shell_tool_call", type: "ShellToolCall" },
    { id: 3, name: "delete_tool_call", type: "DeleteToolCall" },
    { id: 4, name: "glob_tool_call", type: "GlobToolCall" },
    { id: 5, name: "grep_tool_call", type: "GrepToolCall" },
    { id: 8, name: "read_tool_call", type: "ReadToolCall" },
    { id: 9, name: "update_todos_tool_call", type: "UpdateTodosToolCall" },
    { id: 10, name: "read_todos_tool_call", type: "ReadTodosToolCall" },
    { id: 12, name: "edit_tool_call", type: "EditToolCall" },
    { id: 13, name: "ls_tool_call", type: "LsToolCall" },
    { id: 15, name: "mcp_tool_call", type: "McpToolCall" },
    { id: 17, name: "create_plan_tool_call", type: "CreatePlanToolCall" },
    { id: 18, name: "web_search_tool_call", type: "WebSearchToolCall" },
    { id: 19, name: "task_tool_call", type: "TaskToolCall" },
    { id: 23, name: "ask_question_tool_call", type: "AskQuestionToolCall" },
    { id: 24, name: "fetch_tool_call", type: "FetchToolCall" },
    { id: 25, name: "switch_mode_tool_call", type: "SwitchModeToolCall" },
    { id: 28, name: "generate_image_tool_call", type: "GenerateImageToolCall" },
    { id: 37, name: "web_fetch_tool_call", type: "WebFetchToolCall" },
    { id: 42, name: "await_tool_call", type: "AwaitToolCall" },
    { id: 44, name: "get_mcp_tools_tool_call", type: "GetMcpToolsToolCall" },
    { id: 61, name: "pi_read_tool_call", type: "PiReadToolCall" },
    { id: 62, name: "pi_bash_tool_call", type: "PiBashToolCall" },
    { id: 63, name: "pi_edit_tool_call", type: "PiEditToolCall" },
    { id: 64, name: "pi_write_tool_call", type: "PiWriteToolCall" },
    { id: 65, name: "pi_grep_tool_call", type: "PiGrepToolCall" },
    { id: 66, name: "pi_find_tool_call", type: "PiFindToolCall" },
    { id: 67, name: "pi_ls_tool_call", type: "PiLsToolCall" },
  ],
  [{
    name: "tool",
    fields: [
      "shell_tool_call", "delete_tool_call", "glob_tool_call", "grep_tool_call",
      "read_tool_call", "update_todos_tool_call", "read_todos_tool_call",
      "edit_tool_call", "ls_tool_call",
      "mcp_tool_call", "create_plan_tool_call", "web_search_tool_call", "task_tool_call",
      "ask_question_tool_call", "fetch_tool_call", "switch_mode_tool_call",
      "generate_image_tool_call", "web_fetch_tool_call", "await_tool_call", "get_mcp_tools_tool_call",
      "pi_read_tool_call", "pi_bash_tool_call", "pi_edit_tool_call",
      "pi_write_tool_call", "pi_grep_tool_call", "pi_find_tool_call", "pi_ls_tool_call",
    ],
  }],
)

addType(root, "ToolCallStarted", [
  { id: 1, name: "call_id", type: "string" },
  { id: 2, name: "tool_call", type: "ToolCall" },
  { id: 3, name: "model_call_id", type: "string" },
])

// agent.v1 ToolCallCompletedUpdate has no string result field — result lives
// inside the typed ToolCall variant.
addType(root, "ToolCallCompleted", [
  { id: 1, name: "call_id", type: "string" },
  { id: 2, name: "tool_call", type: "ToolCall" },
  { id: 3, name: "model_call_id", type: "string" },
])

addType(root, "PartialToolCall", [
  { id: 1, name: "call_id", type: "string" },
  { id: 2, name: "tool_call", type: "ToolCall" },
  { id: 3, name: "args_text_delta", type: "string" },
  { id: 4, name: "model_call_id", type: "string" },
])

// agent.v1 ToolCallDeltaUpdate: keep the nested delta opaque; the pump
// needs its presence as generation progress, not its display-only content.
addType(root, "ToolCallDeltaUpdate", [
  { id: 1, name: "call_id", type: "string" },
  { id: 2, name: "tool_call_delta", type: "bytes" },
  { id: 3, name: "model_call_id", type: "string" },
])

// agent.v1 StepStartedUpdate / StepCompletedUpdate: step_id is uint64 (T:4),
// not string — wrong type made every step_completed frame throw
// "index out of range" in decodeMessage.
addType(root, "StepStarted", [
  { id: 1, name: "step_id", type: "uint64" },
])

addType(root, "StepCompleted", [
  { id: 1, name: "step_id", type: "uint64" },
  { id: 2, name: "step_duration_ms", type: "int64" },
])

// agent.v1 ToolRequestsListedUpdate — Cursor lists how many tool calls this
// generation will send so the client can place its step boundary (CLI does
// not need this; OpenCode's AI SDK step does). Field 27 on InteractionUpdate.
addType(root, "ToolRequestsListedUpdate", [
  { id: 1, name: "call_count", type: "uint32" },
])

// InteractionUpdate — the core streaming update message
addType(
  root,
  "InteractionUpdate",
  [
    { id: 1, name: "text_delta", type: "TextDeltaUpdate" },
    { id: 2, name: "tool_call_started", type: "ToolCallStarted" },
    { id: 3, name: "tool_call_completed", type: "ToolCallCompleted" },
    { id: 4, name: "thinking_delta", type: "ThinkingDeltaUpdate" },
    { id: 7, name: "partial_tool_call", type: "PartialToolCall" },
    { id: 13, name: "heartbeat", type: "Heartbeat" },
    { id: 14, name: "turn_ended", type: "TurnEnded" },
    { id: 15, name: "tool_call_delta", type: "ToolCallDeltaUpdate" },
    { id: 16, name: "step_started", type: "StepStarted" },
    { id: 17, name: "step_completed", type: "StepCompleted" },
    { id: 23, name: "context_injection_state", type: "ContextInjectionStateUpdate" },
    { id: 27, name: "tool_requests_listed", type: "ToolRequestsListedUpdate" },
  ],
  [{ name: "update", fields: ["text_delta", "tool_call_started", "tool_call_completed", "thinking_delta", "partial_tool_call", "heartbeat", "turn_ended", "tool_call_delta", "step_started", "step_completed", "context_injection_state", "tool_requests_listed"] }],
)

// Server status for an `inject_context_action` (InteractionUpdate #23).
// Cursor CLI only tracks it to show queued steer delivery; it carries no output.
addType(root, "ContextInjectionQueued", [])
addType(root, "ContextInjectionQueuedForNextTurn", [])
addType(root, "ContextInjectionCancelled", [])
addType(root, "ContextInjectionDelivered", [
  { id: 1, name: "step", type: "int32" },
  { id: 2, name: "delivery_batch_id", type: "string" },
  { id: 3, name: "delivered_at_ms", type: "int64" },
])
addType(root, "ContextInjectionRejected", [
  { id: 1, name: "reason", type: "string" },
])
addType(
  root,
  "ContextInjectionState",
  [
    { id: 1, name: "queued", type: "ContextInjectionQueued" },
    { id: 2, name: "delivered", type: "ContextInjectionDelivered" },
    { id: 3, name: "queued_for_next_turn", type: "ContextInjectionQueuedForNextTurn" },
    { id: 4, name: "cancelled", type: "ContextInjectionCancelled" },
    { id: 5, name: "rejected", type: "ContextInjectionRejected" },
  ],
  [{ name: "state", fields: ["queued", "delivered", "queued_for_next_turn", "cancelled", "rejected"] }],
)
addType(root, "ContextInjectionStateUpdate", [
  { id: 1, name: "injection_id", type: "string" },
  { id: 2, name: "state", type: "ContextInjectionState" },
])

}
