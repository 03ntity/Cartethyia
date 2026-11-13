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
 * File-tool exec schemas: Read/ReadResult, Grep/GrepResult,
 * Write/WriteResult, Delete/DeleteResult, and Ls/LsResult. First slice of
 * the original `registerExecTypes` registration order.
 */

export function registerFileToolTypes(root: protobuf.Root): void {
// ── Exec channel ──

// Field numbers match agent.v1. Extra fields we don't use are still declared
// so protobufjs doesn't drop them on decode.
addType(root, "ReadArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "tool_call_id", type: "string" },
  { id: 4, name: "offset", type: "int32" },
  { id: 5, name: "limit", type: "uint32" },
])

// agent.v1 ReadResult is a oneof — flat {content,error} was rejected by the
// server (endless heartbeats after read_result).
addType(
  root,
  "ReadSuccess",
  [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "content", type: "string" },
    { id: 3, name: "total_lines", type: "int32" },
    { id: 4, name: "file_size", type: "int64" },
    { id: 5, name: "data", type: "bytes" },
    { id: 6, name: "truncated", type: "bool" },
    { id: 7, name: "output_blob_id", type: "bytes" },
    { id: 8, name: "range_applied", type: "bool" },
  ],
  [{ name: "output", fields: ["content", "data"] }],
)
addType(root, "ReadError", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "error", type: "string" },
])
// Cursor's LocalReadExecutor validates the target before execution and, for a
// missing / non-regular path, returns one of these typed ReadResult cases
// instead of running the tool. Mirroring the exact field ids/shapes lets this
// provider reply the same way so the model sees a structured file-not-found
// observation and the host never surfaces a permission prompt.
addType(root, "ReadFileNotFound", [{ id: 1, name: "path", type: "string" }])
addType(root, "ReadPermissionDenied", [{ id: 1, name: "path", type: "string" }])
addType(root, "ReadInvalidFile", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "reason", type: "string" },
])
addType(root, "ReadRejected", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "reason", type: "string" },
])
addType(
  root,
  "ReadResult",
  [
    { id: 1, name: "success", type: "ReadSuccess" },
    { id: 2, name: "error", type: "ReadError" },
    { id: 3, name: "rejected", type: "ReadRejected" },
    { id: 4, name: "file_not_found", type: "ReadFileNotFound" },
    { id: 5, name: "permission_denied", type: "ReadPermissionDenied" },
    { id: 6, name: "invalid_file", type: "ReadInvalidFile" },
  ],
  [
    {
      name: "result",
      fields: ["success", "error", "rejected", "file_not_found", "permission_denied", "invalid_file"],
    },
  ],
)

addType(root, "GrepArgs", [
  { id: 1, name: "pattern", type: "string" },
  { id: 2, name: "path", type: "string" },
  { id: 3, name: "glob", type: "string" },
  { id: 4, name: "output_mode", type: "string" },
  { id: 8, name: "case_insensitive", type: "bool" },
  { id: 10, name: "head_limit", type: "int32" },
  { id: 14, name: "tool_call_id", type: "string" },
  { id: 16, name: "offset", type: "int32" },
])

addType(root, "GrepError", [{ id: 1, name: "error", type: "string" }])
addType(root, "GrepFilesResult", [
  { id: 1, name: "files", type: "string", repeated: true },
  { id: 2, name: "total_files", type: "int32" },
  { id: 3, name: "client_truncated", type: "bool" },
])
addType(root, "GrepContentMatch", [
  { id: 1, name: "line_number", type: "int32" },
  { id: 2, name: "content", type: "string" },
])
addType(root, "GrepFileMatch", [
  { id: 1, name: "file", type: "string" },
  { id: 2, name: "matches", type: "GrepContentMatch", repeated: true },
])
addType(root, "GrepContentResult", [
  { id: 1, name: "matches", type: "GrepFileMatch", repeated: true },
  { id: 2, name: "total_lines", type: "int32" },
  { id: 3, name: "total_matched_lines", type: "int32" },
  { id: 4, name: "client_truncated", type: "bool" },
  { id: 5, name: "ripgrep_truncated", type: "bool" },
])
addType(
  root,
  "GrepUnionResult",
  [
    { id: 2, name: "files", type: "GrepFilesResult" },
    { id: 3, name: "content", type: "GrepContentResult" },
  ],
  [{ name: "result", fields: ["files", "content"] }],
)
{
  const t = new protobuf.Type("GrepSuccess")
  t.add(new protobuf.Field("pattern", 1, "string"))
  t.add(new protobuf.Field("path", 2, "string"))
  t.add(new protobuf.Field("output_mode", 3, "string"))
  t.add(new protobuf.MapField("workspace_results", 4, "string", "GrepUnionResult"))
  root.add(t)
}
addType(
  root,
  "GrepResult",
  [
    { id: 1, name: "success", type: "GrepSuccess" },
    { id: 2, name: "error", type: "GrepError" },
  ],
  [{ name: "result", fields: ["success", "error"] }],
)

// agent.v1.WriteArgs. Cursor's own LocalWriteExecutor reads `file_bytes`
// first and only falls back to `file_text`, so a write whose content arrives
// as bytes decodes to an empty string unless field 5 is declared here.
addType(root, "WriteArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "file_text", type: "string" },
  { id: 3, name: "tool_call_id", type: "string" },
  { id: 4, name: "return_file_content_after_write", type: "bool" },
  { id: 5, name: "file_bytes", type: "bytes" },
  { id: 6, name: "encoding_hint", type: "string" },
])

addType(root, "WriteSuccess", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "lines_created", type: "int32" },
  { id: 3, name: "file_size", type: "int32" },
  { id: 4, name: "file_content_after_write", type: "string" },
])
addType(root, "WriteError", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "error", type: "string" },
])
// Cursor's own executor reports a refused write with this variant rather than
// a generic error, and its agent reads `operation` / `is_readonly` back.
addType(root, "WritePermissionDenied", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "directory", type: "string" },
  { id: 3, name: "operation", type: "string" },
  { id: 4, name: "error", type: "string" },
  { id: 5, name: "is_readonly", type: "bool" },
])
addType(root, "WriteRejected", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "reason", type: "string" },
])
addType(
  root,
  "WriteResult",
  [
    { id: 1, name: "success", type: "WriteSuccess" },
    { id: 3, name: "permission_denied", type: "WritePermissionDenied" },
    { id: 5, name: "error", type: "WriteError" },
    { id: 6, name: "rejected", type: "WriteRejected" },
  ],
  [{ name: "result", fields: ["success", "permission_denied", "error", "rejected"] }],
)

// agent.v1 Pi exec results. Cursor places Pi requests at ExecServerMessage
// fields #45..#51 and their corresponding ExecClientMessage results at
// #46..#52 (the result fields are deliberately offset by one).
//
// The success payloads contain additional optional truncation/diff metadata;
// OpenCode returns text, so the minimal output/error shapes are sufficient.
addType(root, "PiWriteArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "content", type: "string" },
])
addType(root, "PiWriteSuccess", [
  { id: 1, name: "output", type: "string" },
])
addType(root, "PiWriteError", [
  { id: 1, name: "error", type: "string" },
])
addType(root, "PiWriteRejected", [
  { id: 1, name: "reason", type: "string" },
])
addType(
  root,
  "PiWriteResult",
  [
    { id: 1, name: "success", type: "PiWriteSuccess" },
    { id: 2, name: "error", type: "PiWriteError" },
    { id: 3, name: "rejected", type: "PiWriteRejected" },
  ],
  [{ name: "result", fields: ["success", "error", "rejected"] }],
)
// agent.v1.PiTruncation. Every Pi *ExecSuccess shares output(1)+truncation(2)
// and only diverges at field 3, so the shared PiOutputSuccess can carry it.
// Cursor's own CLI always reports truncation rather than silently shortening
// a payload; emitting this keeps a capped read distinguishable from a
// complete one.
addType(root, "PiTruncation", [
  { id: 1, name: "truncated", type: "bool" },
  { id: 2, name: "truncated_by", type: "string" },
  { id: 3, name: "total_lines", type: "uint32" },
  { id: 4, name: "output_lines", type: "uint32" },
  { id: 5, name: "output_bytes", type: "uint32" },
  { id: 6, name: "max_lines", type: "uint32" },
  { id: 7, name: "max_bytes", type: "uint32" },
  { id: 8, name: "first_line_exceeds_limit", type: "bool" },
  { id: 9, name: "last_line_partial", type: "bool" },
])
addType(root, "PiOutputSuccess", [
  { id: 1, name: "output", type: "string" },
  { id: 2, name: "truncation", type: "PiTruncation" },
])
addType(root, "PiExecError", [{ id: 1, name: "error", type: "string" }])
addType(root, "PiExecRejected", [{ id: 1, name: "reason", type: "string" }])
for (const resultType of [
  "PiReadExecResult",
  "PiBashExecResult",
  "PiGrepExecResult",
  "PiFindExecResult",
  "PiLsExecResult",
]) {
  addType(
    root,
    resultType,
    [
      { id: 1, name: "success", type: "PiOutputSuccess" },
      { id: 2, name: "error", type: "PiExecError" },
    ],
    [{ name: "result", fields: ["success", "error"] }],
  )
}
addType(
  root,
  "PiEditExecResult",
  [
    { id: 1, name: "success", type: "PiOutputSuccess" },
    { id: 2, name: "error", type: "PiExecError" },
    { id: 3, name: "rejected", type: "PiExecRejected" },
  ],
  [{ name: "result", fields: ["success", "error", "rejected"] }],
)

addType(root, "DeleteArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "tool_call_id", type: "string" },
])

addType(root, "DeleteSuccess", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "deleted_file", type: "string" },
])
addType(root, "DeleteError", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "error", type: "string" },
])
addType(root, "DeletePermissionDenied", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "client_visible_error", type: "string" },
  { id: 3, name: "is_readonly", type: "bool" },
])
addType(root, "DeleteRejected", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "reason", type: "string" },
])
addType(
  root,
  "DeleteResult",
  [
    { id: 1, name: "success", type: "DeleteSuccess" },
    { id: 4, name: "permission_denied", type: "DeletePermissionDenied" },
    { id: 6, name: "rejected", type: "DeleteRejected" },
    { id: 7, name: "error", type: "DeleteError" },
  ],
  [{ name: "result", fields: ["success", "permission_denied", "rejected", "error"] }],
)

addType(root, "LsArgs", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "ignore", type: "string", repeated: true },
  { id: 3, name: "tool_call_id", type: "string" },
])

addType(root, "LsDirectoryTreeFile", [{ id: 1, name: "name", type: "string" }])
addType(root, "LsDirectoryTreeNode", [
  { id: 1, name: "abs_path", type: "string" },
  { id: 2, name: "children_dirs", type: "LsDirectoryTreeNode", repeated: true },
  { id: 3, name: "children_files", type: "LsDirectoryTreeFile", repeated: true },
  { id: 6, name: "num_files", type: "int32" },
])
addType(root, "LsSuccess", [
  { id: 1, name: "directory_tree_root", type: "LsDirectoryTreeNode" },
])
addType(root, "LsError", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "error", type: "string" },
])
addType(root, "LsRejected", [
  { id: 1, name: "path", type: "string" },
  { id: 2, name: "reason", type: "string" },
])
addType(
  root,
  "LsResult",
  [
    { id: 1, name: "success", type: "LsSuccess" },
    { id: 2, name: "error", type: "LsError" },
    { id: 3, name: "rejected", type: "LsRejected" },
  ],
  [{ name: "result", fields: ["success", "error", "rejected"] }],
)

}
