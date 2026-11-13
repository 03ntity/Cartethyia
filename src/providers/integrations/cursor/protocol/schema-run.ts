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
 * Run-request / envelope schema: run request types, interaction
 * query/response channel, KV blob store, and the Agent client/server
 * message envelopes. Registered after display + exec (it references them).
 */

export function registerRunTypes(root: protobuf.Root): void {
// ── Run request types ──

addType(root, "ParameterValue", [
  { id: 1, name: "id", type: "string" },
  { id: 2, name: "value", type: "string" },
])

addType(root, "RequestedModel", [
  { id: 1, name: "model_id", type: "string" },
  { id: 2, name: "max_mode", type: "bool" },
  { id: 3, name: "parameters", type: "ParameterValue", repeated: true },
])

addType(root, "SelectedImageDimension", [
  { id: 1, name: "width", type: "int32" },
  { id: 2, name: "height", type: "int32" },
])
addType(root, "SelectedImageBlobIdWithData", [
  { id: 1, name: "blob_id", type: "bytes" },
  { id: 2, name: "data", type: "bytes" },
])
addType(
  root,
  "SelectedImage",
  [
    { id: 1, name: "blob_id", type: "bytes" },
    { id: 8, name: "data", type: "bytes" },
    { id: 9, name: "blob_id_with_data", type: "SelectedImageBlobIdWithData" },
    { id: 2, name: "uuid", type: "string" },
    { id: 3, name: "path", type: "string" },
    { id: 4, name: "dimension", type: "SelectedImageDimension" },
    { id: 7, name: "mime_type", type: "string" },
  ],
  [{ name: "data_or_blob_id", fields: ["blob_id", "data", "blob_id_with_data"] }],
)
addType(root, "SelectedContext", [
  { id: 1, name: "selected_images", type: "SelectedImage", repeated: true },
])

// agent.v1.AgentMode — the client's current mode, sent on every user message.
root.add(new protobuf.Enum("AgentMode", {
  AGENT_MODE_UNSPECIFIED: 0,
  AGENT_MODE_AGENT: 1,
  AGENT_MODE_ASK: 2,
  AGENT_MODE_PLAN: 3,
  AGENT_MODE_DEBUG: 4,
  AGENT_MODE_TRIAGE: 5,
  AGENT_MODE_PROJECT: 6,
  AGENT_MODE_MULTITASK: 7,
  AGENT_MODE_CUSTOM: 8,
}))

addType(root, "UserMessage", [
  { id: 1, name: "text", type: "string" },
  { id: 2, name: "message_id", type: "string" },
  { id: 3, name: "selected_context", type: "SelectedContext" },
  { id: 4, name: "mode", type: "AgentMode" },
])

// RequestContext — UserMessageAction #2. Slim mcp_meta_tool_options names
// the advertised catalog; AgentRunRequest.mcp_tools (#4) is empty on real turns.
addType(root, "RequestContext", [
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

addType(root, "UserMessageAction", [
  { id: 1, name: "user_message", type: "UserMessage" },
  { id: 2, name: "request_context", type: "RequestContext" },
])

addType(root, "ResumeAction", [
  // Cursor CLI sends an empty ResumeAction. Field #2 is available for a
  // refreshed RequestContext; the conversation id belongs to AgentRunRequest.
  { id: 2, name: "request_context", type: "RequestContext" },
])

addType(root, "CancelAction", [
  // `agent.proto` declares CancelAction empty (oneof presence is the signal);
  // the reason travels on the stream, not in the message.
])

// Deferred answers for an AskQuestion the client already replied to with
// `async`. `original_args` is kept as raw bytes so the exact AskQuestionArgs
// Cursor sent — including fields this schema does not model — is echoed back
// verbatim rather than re-encoded from a lossy decode.
addType(root, "AsyncAskQuestionCompletionAction", [
  { id: 1, name: "original_tool_call_id", type: "string" },
  { id: 2, name: "original_args", type: "bytes" },
  { id: 3, name: "result", type: "AskQuestionResult" },
])

// Cursor CLI 2026.10.01 descriptors: system context is
// injected into the current Run without submitting another user turn.
addType(root, "SystemContextInjection", [
  { id: 1, name: "producer", type: "string" },
  { id: 2, name: "content", type: "string" },
])
// Cursor SDK `Run.steer` / CLI steering payload: a user message added to the
// running turn. `request_context` is optional and unused by the SDK.
addType(root, "UserContextInjection", [
  { id: 1, name: "user_message", type: "UserMessage" },
  { id: 2, name: "request_context", type: "RequestContext" },
])
addType(root, "InjectContextAction", [
  { id: 1, name: "injection_id", type: "string" },
  { id: 2, name: "expected_run_id", type: "string" },
  { id: 3, name: "user_context", type: "UserContextInjection" },
  { id: 4, name: "system_context", type: "SystemContextInjection" },
])

addType(
  root,
  "ConversationAction",
  [
    { id: 1, name: "user_message_action", type: "UserMessageAction" },
    { id: 2, name: "resume_action", type: "ResumeAction" },
    { id: 3, name: "cancel_action", type: "CancelAction" },
    { id: 8, name: "async_ask_question_completion_action", type: "AsyncAskQuestionCompletionAction" },
    { id: 19, name: "inject_context_action", type: "InjectContextAction" },
  ],
  [{
    name: "action",
    fields: [
      "user_message_action",
      "resume_action",
      "cancel_action",
      "async_ask_question_completion_action",
      "inject_context_action",
    ],
  }],
)

// Seed ConversationStateStructure for turn 1 (system prompt as JSON strings
// in #1). After the first conversation_checkpoint_update we echo opaque
// server bytes instead — CLI's live structure uses blob-id bytes in #1/#8.
addType(root, "AssistantMessage", [
  { id: 1, name: "text", type: "string" },
])

addType(
  root,
  "ConversationStep",
  [
    { id: 1, name: "assistant_message", type: "AssistantMessage" },
  ],
  [{ name: "message", fields: ["assistant_message"] }],
)

addType(root, "AgentConversationTurn", [
  { id: 1, name: "user_message", type: "UserMessage" },
  { id: 2, name: "steps", type: "ConversationStep", repeated: true },
])

addType(
  root,
  "ConversationTurn",
  [
    { id: 1, name: "agent_conversation_turn", type: "AgentConversationTurn" },
  ],
  [{ name: "turn", fields: ["agent_conversation_turn"] }],
)

// Cursor checkpoints carry authoritative context occupancy in field #5. The
// provider still transports the complete checkpoint as opaque bytes; these
// declarations support targeted diagnostics/tests without a re-encode.
addType(root, "PromptTokenBreakdownCategory", [
  { id: 1, name: "id", type: "string" },
  { id: 2, name: "label", type: "string" },
  { id: 3, name: "estimated_tokens", type: "uint32" },
  { id: 4, name: "character_count", type: "uint32" },
])
addType(root, "PromptTokenBreakdownSnapshot", [
  { id: 1, name: "total_used_tokens", type: "uint32" },
  { id: 2, name: "max_tokens", type: "uint32" },
  { id: 3, name: "categories", type: "PromptTokenBreakdownCategory", repeated: true },
])
addType(root, "ConversationTokenDetails", [
  { id: 1, name: "used_tokens", type: "uint32" },
  { id: 2, name: "max_tokens", type: "uint32" },
  { id: 3, name: "breakdown", type: "PromptTokenBreakdownSnapshot" },
])

// Seed schema (JSON strings). AgentRunRequest.conversation_state remains
// bytes, so live checkpoints are never decoded/re-encoded on transport.
addType(root, "ConversationStateStructure", [
  { id: 1, name: "root_prompt_messages_json", type: "string", repeated: true },
  { id: 5, name: "token_details", type: "ConversationTokenDetails" },
  { id: 8, name: "turns", type: "ConversationTurn", repeated: true },
])

// `agent.proto` ModelDetails.thinking_details — empty in the current build;
// declared for wire-shape completeness.
addType(root, "ThinkingDetails", [])

// `agent.proto` AgentRunRequest.skill_options (deprecated upstream; kept for
// wire-shape completeness).
addType(root, "SkillOptions", [
  { id: 1, name: "skill_descriptors", type: "SkillDescriptor", repeated: true },
])

addType(root, "ModelDetails", [
  { id: 1, name: "model_id", type: "string" },
  { id: 2, name: "thinking_details", type: "ThinkingDetails" },
  { id: 3, name: "display_model_id", type: "string" },
  { id: 4, name: "display_name", type: "string" },
  { id: 5, name: "display_name_short", type: "string" },
  { id: 6, name: "aliases", type: "string", repeated: true },
  { id: 7, name: "max_mode", type: "bool" },
])

addType(root, "McpTools", [
  { id: 1, name: "mcp_tools", type: "McpToolDefinition", repeated: true },
])

addType(root, "AgentRunRequest", [
  { id: 1, name: "conversation_state", type: "bytes" },
  { id: 2, name: "action", type: "ConversationAction" },
  { id: 3, name: "model_details", type: "ModelDetails" },
  { id: 4, name: "mcp_tools", type: "McpTools" },
  { id: 5, name: "conversation_id", type: "string" },
  { id: 6, name: "mcp_file_system_options", type: "McpFileSystemOptions" },
  { id: 7, name: "skill_options", type: "SkillOptions" },
  { id: 8, name: "custom_system_prompt", type: "string" },
  { id: 9, name: "requested_model", type: "RequestedModel" },
])

// ── Client heartbeat ──

addType(root, "ClientHeartbeat", [])

// ── Interaction query/response channel ──
// Cursor sends UI/integration requests outside the exec tool channel. Query
// bodies stay opaque: this headless provider only needs their id + variant
// to return a conservative typed response on the same Run stream.
addType(
  root,
  "InteractionQuery",
  [
    { id: 1, name: "id", type: "uint32" },
    { id: 2, name: "web_search_request_query", type: "bytes" },
    { id: 3, name: "ask_question_interaction_query", type: "bytes" },
    { id: 4, name: "switch_mode_request_query", type: "bytes" },
    { id: 7, name: "create_plan_request_query", type: "bytes" },
    { id: 8, name: "setup_vm_environment_args", type: "bytes" },
    { id: 9, name: "web_fetch_request_query", type: "bytes" },
    { id: 10, name: "pr_management_request_query", type: "bytes" },
    { id: 11, name: "mcp_auth_request_query", type: "bytes" },
    { id: 12, name: "generate_image_request_query", type: "bytes" },
    { id: 13, name: "replace_env_args", type: "bytes" },
    { id: 14, name: "connect_scm_request_query", type: "bytes" },
  ],
  [{
    name: "query",
    fields: [
      "web_search_request_query", "ask_question_interaction_query",
      "switch_mode_request_query", "create_plan_request_query",
      "setup_vm_environment_args", "web_fetch_request_query",
      "pr_management_request_query", "mcp_auth_request_query",
      "generate_image_request_query", "replace_env_args",
      "connect_scm_request_query",
    ],
  }],
)

addType(root, "WebSearchRequestApproved", [])
addType(root, "WebSearchRequestRejected", [{ id: 1, name: "reason", type: "string" }])
addType(root, "WebSearchRequestResponse", [
  { id: 1, name: "approved", type: "WebSearchRequestApproved" },
  { id: 2, name: "rejected", type: "WebSearchRequestRejected" },
], [{ name: "result", fields: ["approved", "rejected"] }])

addType(root, "AskQuestionRejected", [{ id: 1, name: "reason", type: "string" }])
addType(root, "AskQuestionError", [{ id: 1, name: "error_message", type: "string" }])
addType(root, "AskQuestionAsync", [])
addType(root, "AskQuestionSuccessAnswer", [
  { id: 1, name: "question_id", type: "string" },
  { id: 2, name: "selected_option_ids", type: "string", repeated: true },
  { id: 3, name: "freeform_text", type: "string" },
])
addType(root, "AskQuestionSuccess", [
  { id: 1, name: "answers", type: "AskQuestionSuccessAnswer", repeated: true },
])
addType(root, "AskQuestionResult", [
  { id: 1, name: "success", type: "AskQuestionSuccess" },
  { id: 2, name: "error", type: "AskQuestionError" },
  { id: 3, name: "rejected", type: "AskQuestionRejected" },
  { id: 4, name: "async", type: "AskQuestionAsync" },
], [{ name: "result", fields: ["success", "error", "rejected", "async"] }])
addType(root, "AskQuestionInteractionResponse", [
  { id: 1, name: "result", type: "AskQuestionResult" },
])
// InteractionQuery keeps query bodies opaque (see the InteractionQuery
// comment); this type decodes only the ask-question body on demand.
addType(root, "AskQuestionInteractionQuery", [
  { id: 1, name: "args", type: "AskQuestionArgs" },
  { id: 2, name: "tool_call_id", type: "string" },
])

addType(root, "SwitchModeRequestApproved", [])
addType(root, "SwitchModeRequestRejected", [{ id: 1, name: "reason", type: "string" }])
addType(root, "SwitchModeRequestResponse", [
  { id: 1, name: "approved", type: "SwitchModeRequestApproved" },
  { id: 2, name: "rejected", type: "SwitchModeRequestRejected" },
], [{ name: "result", fields: ["approved", "rejected"] }])
// InteractionQuery keeps query bodies opaque; decoded on demand like
// AskQuestionInteractionQuery / CreatePlanRequestQuery.
addType(root, "SwitchModeRequestQuery", [
  { id: 1, name: "args", type: "SwitchModeToolArgs" },
])

addType(root, "CreatePlanSuccess", [])
addType(root, "CreatePlanError", [{ id: 1, name: "error", type: "string" }])
addType(root, "CreatePlanResult", [
  { id: 1, name: "success", type: "CreatePlanSuccess" },
  { id: 2, name: "error", type: "CreatePlanError" },
  { id: 3, name: "plan_uri", type: "string" },
], [{ name: "result", fields: ["success", "error"] }])
addType(root, "CreatePlanRequestResponse", [
  { id: 1, name: "result", type: "CreatePlanResult" },
])
// InteractionQuery keeps query bodies opaque; decoded on demand like
// AskQuestionInteractionQuery / GenerateImageRequestQuery.
addType(root, "CreatePlanRequestQuery", [
  { id: 1, name: "args", type: "CreatePlanArgs" },
  { id: 2, name: "tool_call_id", type: "string" },
])

addType(root, "SetupVmEnvironmentSuccess", [])
addType(root, "SetupVmEnvironmentResult", [
  { id: 1, name: "success", type: "SetupVmEnvironmentSuccess" },
], [{ name: "result", fields: ["success"] }])

addType(root, "WebFetchRequestApproved", [])
addType(root, "WebFetchRequestRejected", [{ id: 1, name: "reason", type: "string" }])
addType(root, "WebFetchRequestResponse", [
  { id: 1, name: "approved", type: "WebFetchRequestApproved" },
  { id: 2, name: "rejected", type: "WebFetchRequestRejected" },
], [{ name: "result", fields: ["approved", "rejected"] }])

addType(root, "PrManagementRejected", [{ id: 1, name: "reason", type: "string" }])
addType(root, "PrManagementResult", [
  { id: 3, name: "rejected", type: "PrManagementRejected" },
], [{ name: "result", fields: ["rejected"] }])

addType(root, "McpAuthRequestApproved", [])
addType(root, "McpAuthRequestRejected", [{ id: 1, name: "reason", type: "string" }])
addType(root, "McpAuthRequestResponse", [
  { id: 1, name: "approved", type: "McpAuthRequestApproved" },
  { id: 2, name: "rejected", type: "McpAuthRequestRejected" },
], [{ name: "result", fields: ["approved", "rejected"] }])

addType(root, "GenerateImageRequestApproved", [{ id: 1, name: "description", type: "string" }])
addType(root, "GenerateImageRequestRejected", [{ id: 1, name: "reason", type: "string" }])
addType(root, "GenerateImageRequestResponse", [
  { id: 1, name: "approved", type: "GenerateImageRequestApproved" },
  { id: 2, name: "rejected", type: "GenerateImageRequestRejected" },
], [{ name: "result", fields: ["approved", "rejected"] }])

addType(root, "ReplaceEnvSuccess", [])
addType(root, "ReplaceEnvFailure", [
  { id: 1, name: "error_message", type: "string" },
  { id: 2, name: "setup_logs", type: "string" },
])
addType(root, "ReplaceEnvResult", [
  { id: 1, name: "success", type: "ReplaceEnvSuccess" },
  { id: 2, name: "failure", type: "ReplaceEnvFailure" },
], [{ name: "result", fields: ["success", "failure"] }])

addType(root, "ConnectScmRequestApproved", [])
addType(root, "ConnectScmRequestRejected", [{ id: 1, name: "reason", type: "string" }])
addType(root, "ConnectScmRequestFailed", [{ id: 1, name: "error", type: "string" }])
addType(root, "ConnectScmRequestResponse", [
  { id: 1, name: "approved", type: "ConnectScmRequestApproved" },
  { id: 2, name: "rejected", type: "ConnectScmRequestRejected" },
  { id: 3, name: "failed", type: "ConnectScmRequestFailed" },
], [{ name: "result", fields: ["approved", "rejected", "failed"] }])

addType(
  root,
  "InteractionResponse",
  [
    { id: 1, name: "id", type: "uint32" },
    { id: 2, name: "web_search_request_response", type: "WebSearchRequestResponse" },
    { id: 3, name: "ask_question_interaction_response", type: "AskQuestionInteractionResponse" },
    { id: 4, name: "switch_mode_request_response", type: "SwitchModeRequestResponse" },
    { id: 7, name: "create_plan_request_response", type: "CreatePlanRequestResponse" },
    { id: 8, name: "setup_vm_environment_result", type: "SetupVmEnvironmentResult" },
    { id: 9, name: "web_fetch_request_response", type: "WebFetchRequestResponse" },
    { id: 10, name: "pr_management_result", type: "PrManagementResult" },
    { id: 11, name: "mcp_auth_request_response", type: "McpAuthRequestResponse" },
    { id: 12, name: "generate_image_request_response", type: "GenerateImageRequestResponse" },
    { id: 13, name: "replace_env_result", type: "ReplaceEnvResult" },
    { id: 14, name: "connect_scm_request_response", type: "ConnectScmRequestResponse" },
  ],
  [{
    name: "result",
    fields: [
      "web_search_request_response", "ask_question_interaction_response",
      "switch_mode_request_response", "create_plan_request_response",
      "setup_vm_environment_result", "web_fetch_request_response",
      "pr_management_result", "mcp_auth_request_response",
      "generate_image_request_response", "replace_env_result",
      "connect_scm_request_response",
    ],
  }],
)

// ── KV blob store (cursor moves large payloads out-of-band via this channel) ──
// Server sends KvServerMessage (AgentServerMessage #4); client MUST reply with
// KvClientMessage (AgentClientMessage #3) on the same Run stream, echoing `id`.
// If we don't ack set_blob / answer get_blob, the server hangs (endless
// heartbeats, no response) — this was the "no response" root cause.

addType(root, "GetBlobArgs", [
  { id: 1, name: "blob_id", type: "bytes" },
])
addType(root, "GetBlobResult", [
  { id: 1, name: "blob_data", type: "bytes" },
])
addType(root, "SetBlobArgs", [
  { id: 1, name: "blob_id", type: "bytes" },
  { id: 2, name: "blob_data", type: "bytes" },
])
addType(root, "SetBlobResult", [
  { id: 1, name: "error", type: "string" },
])
addType(
  root,
  "KvServerMessage",
  [
    { id: 1, name: "id", type: "uint32" },
    { id: 2, name: "get_blob_args", type: "GetBlobArgs" },
    { id: 3, name: "set_blob_args", type: "SetBlobArgs" },
  ],
  [{ name: "message", fields: ["get_blob_args", "set_blob_args"] }],
)
addType(
  root,
  "KvClientMessage",
  [
    { id: 1, name: "id", type: "uint32" },
    { id: 2, name: "get_blob_result", type: "GetBlobResult" },
    { id: 3, name: "set_blob_result", type: "SetBlobResult" },
  ],
  [{ name: "message", fields: ["get_blob_result", "set_blob_result"] }],
)

// ── AgentClientMessage ──

addType(
  root,
  "AgentClientMessage",
  [
    { id: 1, name: "run_request", type: "AgentRunRequest" },
    { id: 2, name: "exec_client_message", type: "ExecClientMessage" },
    { id: 3, name: "kv_client_message", type: "KvClientMessage" },
    { id: 4, name: "conversation_action", type: "ConversationAction" },
    { id: 5, name: "exec_client_control_message", type: "ExecClientControlMessage" },
    { id: 6, name: "interaction_response", type: "InteractionResponse" },
    { id: 7, name: "client_heartbeat", type: "ClientHeartbeat" },
  ],
  [{
    name: "message",
    fields: [
      "run_request",
      "exec_client_message",
      "kv_client_message",
      "conversation_action",
      "exec_client_control_message",
      "interaction_response",
      "client_heartbeat",
    ],
  }],
)

// ── AgentServerMessage ──

addType(
  root,
  "AgentServerMessage",
  [
    { id: 1, name: "interaction_update", type: "InteractionUpdate" },
    { id: 2, name: "exec_server_message", type: "ExecServerMessage" },
    { id: 3, name: "conversation_checkpoint_update", type: "bytes" },
    { id: 4, name: "kv_server_message", type: "KvServerMessage" },
    { id: 5, name: "exec_server_control_message", type: "ExecServerControlMessage" },
    { id: 7, name: "interaction_query", type: "InteractionQuery" },
  ],
  [{ name: "message", fields: ["interaction_update", "exec_server_message", "conversation_checkpoint_update", "kv_server_message", "exec_server_control_message", "interaction_query"] }],
)

}
