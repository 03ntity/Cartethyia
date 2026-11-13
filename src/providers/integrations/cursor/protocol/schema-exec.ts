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
import { registerFileToolTypes } from "./schema-exec-files"
import { registerShellTypes } from "./schema-exec-shell"
import { registerIntegrationTypes } from "./schema-exec-integrations"
import { registerContextTypes } from "./schema-exec-context"
import { registerWireTypes } from "./schema-exec-wire"

/**
 * Exec-channel schema facade: `ExecServerMessage` args, `ExecClientMessage`
 * results, shell streams, MCP exec, request-context probe, and allowlist
 * prechecks. Delegates to contiguous registrar modules in the original
 * registration order. Registered before the run-request schema, which
 * references these types.
 */
export function registerExecTypes(root: protobuf.Root): void {
  registerFileToolTypes(root)
  registerShellTypes(root)
  registerIntegrationTypes(root)
  registerContextTypes(root)
  registerWireTypes(root)
}
