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
 * Shell exec schemas: ShellArgs and the ShellStream event types, plus the
 * encode-only soft-deny stubs and shared reply types (diagnostics, fetch,
 * computer-use, force-background, allowlist precheck results). Second slice
 * of the original `registerExecTypes` registration order.
 */

export function registerShellTypes(root: protobuf.Root): void {
addType(root, "ShellArgs", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "working_directory", type: "string" },
  { id: 3, name: "timeout", type: "uint32" },
  { id: 4, name: "tool_call_id", type: "string" },
  // Canonical agent.v1 fields used by the native CLI to distinguish a
  // foreground cancellation deadline from a soft background handoff.
  { id: 13, name: "timeout_behavior", type: "uint32" },
  { id: 14, name: "hard_timeout", type: "uint32" },
  { id: 15, name: "description", type: "string" },
])

addType(root, "ShellStreamStart", []) // optional SandboxPolicy only; empty is valid
addType(root, "ShellStreamStdout", [{ id: 1, name: "data", type: "string" }])
addType(root, "ShellStreamStderr", [{ id: 1, name: "data", type: "string" }])
// agent.v1: code is uint32; protobufjs must emit code=0 (defaults are load-bearing).
addType(root, "ShellStreamExit", [
  { id: 1, name: "code", type: "uint32" },
  { id: 2, name: "cwd", type: "string" },
  { id: 4, name: "aborted", type: "bool" },
  { id: 5, name: "abort_reason", type: "uint32" },
  { id: 6, name: "local_execution_time_ms", type: "uint32" },
])
addType(root, "ShellStreamBackgrounded", [
  { id: 1, name: "shell_id", type: "uint32" },
  { id: 2, name: "command", type: "string" },
  { id: 3, name: "working_directory", type: "string" },
  { id: 4, name: "pid", type: "uint32" },
  { id: 5, name: "ms_to_wait", type: "uint32" },
  { id: 6, name: "reason", type: "uint32" },
])
// ShellRejected / ShellPermissionDenied (shared with ShellResult) — reason/error at #3.
addType(root, "ShellRejected", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "working_directory", type: "string" },
  { id: 3, name: "reason", type: "string" },
])
addType(root, "ShellPermissionDenied", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "working_directory", type: "string" },
  { id: 3, name: "error", type: "string" },
])

// ── Soft-deny stubs for known unsupported Cursor-native exec variants ──
// These are encode-only: enough to emit a populated deny, not full success.
// Canonical field numbers from agent.proto ExecClientMessage.
// ShellResult is also the live reply for exec #2 shell_args (OpenCode bash).
addType(root, "ShellSuccess", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "working_directory", type: "string" },
  { id: 3, name: "exit_code", type: "int32" },
  { id: 4, name: "signal", type: "string" },
  { id: 5, name: "stdout", type: "string" },
  { id: 6, name: "stderr", type: "string" },
  { id: 7, name: "execution_time", type: "int32" },
  { id: 9, name: "shell_id", type: "uint32" },
  { id: 11, name: "pid", type: "uint32" },
  { id: 12, name: "ms_to_wait", type: "int32" },
  { id: 13, name: "local_execution_time_ms", type: "int32" },
  { id: 14, name: "background_reason", type: "uint32" },
])
addType(root, "ShellFailure", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "working_directory", type: "string" },
  { id: 3, name: "exit_code", type: "int32" },
  { id: 4, name: "signal", type: "string" },
  { id: 5, name: "stdout", type: "string" },
  { id: 6, name: "stderr", type: "string" },
  { id: 7, name: "execution_time", type: "int32" },
  { id: 10, name: "abort_reason", type: "uint32" },
  { id: 11, name: "aborted", type: "bool" },
])
addType(root, "ShellTimeout", [
  { id: 1, name: "command", type: "string" },
  { id: 2, name: "working_directory", type: "string" },
  { id: 3, name: "timeout_ms", type: "int32" },
])
addType(
  root,
  "ShellResult",
  [
    { id: 1, name: "success", type: "ShellSuccess" },
    { id: 2, name: "failure", type: "ShellFailure" },
    { id: 3, name: "timeout", type: "ShellTimeout" },
    { id: 4, name: "rejected", type: "ShellRejected" },
    { id: 7, name: "permission_denied", type: "ShellPermissionDenied" },
    { id: 102, name: "is_background", type: "bool" },
    { id: 104, name: "pid", type: "uint32" },
  ],
  [{ name: "result", fields: ["success", "failure", "timeout", "rejected", "permission_denied"] }],
)
addType(root, "DiagnosticsError", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "error", type: "string" },
])
addType(root, "DiagnosticsResult", [
  { id: 2, name: "error", type: "DiagnosticsError" },
], [{ name: "result", fields: ["error"] }])
addType(root, "FetchError", [
  { id: 1, name: "url", type: "string" },
  { id: 2, name: "error", type: "string" },
])
addType(root, "FetchResult", [
  { id: 2, name: "error", type: "FetchError" },
], [{ name: "result", fields: ["error"] }])
addType(root, "RecordScreenFailure", [
  { id: 1, name: "error", type: "string" },
])
addType(root, "RecordScreenResult", [
  { id: 4, name: "failure", type: "RecordScreenFailure" },
], [{ name: "result", fields: ["failure"] }])
addType(root, "ComputerUseError", [
  { id: 1, name: "error", type: "string" },
])
addType(root, "ComputerUseResult", [
  { id: 2, name: "error", type: "ComputerUseError" },
], [{ name: "result", fields: ["error"] }])
addType(root, "WriteShellStdinError", [
  { id: 1, name: "error", type: "string" },
])
addType(root, "WriteShellStdinResult", [
  { id: 2, name: "error", type: "WriteShellStdinError" },
], [{ name: "result", fields: ["error"] }])
addType(root, "SubagentAwaitError", [
  { id: 1, name: "agent_id", type: "string" },
  { id: 2, name: "error", type: "string" },
])
addType(root, "SubagentAwaitResult", [
  { id: 4, name: "error", type: "SubagentAwaitError" },
], [{ name: "result", fields: ["error"] }])
addType(root, "SmartModeClassifierError", [
  { id: 1, name: "error", type: "string" },
])
addType(root, "SmartModeClassifierResult", [
  { id: 2, name: "error", type: "SmartModeClassifierError" },
], [{ name: "result", fields: ["error"] }])
addType(root, "CanvasDiagnosticsError", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "error", type: "string" },
])
addType(root, "CanvasDiagnosticsResult", [
  { id: 2, name: "error", type: "CanvasDiagnosticsError" },
], [{ name: "result", fields: ["error"] }])
addType(root, "ShellAllowlistPrecheckResult", [
  { id: 1, name: "allowlisted", type: "bool" },
])
addType(root, "McpAllowlistPrecheckResult", [
  { id: 1, name: "allowlisted", type: "bool" },
])
addType(root, "WebFetchAllowlistPrecheckResult", [
  { id: 1, name: "allowlisted", type: "bool" },
])
addType(root, "ForceBackgroundShellResult", [
  { id: 1, name: "status", type: "uint32" },
])
addType(root, "ForceBackgroundSubagentResult", [
  { id: 1, name: "status", type: "uint32" },
])
}
