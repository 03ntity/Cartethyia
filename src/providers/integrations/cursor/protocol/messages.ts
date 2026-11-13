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
import { registerDisplayTypes } from "./schema-display"
import { registerExecTypes } from "./schema-exec"
import { registerRunTypes } from "./schema-run"
import { registerModelTypes } from "./schema-models"

/**
 * Cursor `agent.proto` schema, split by domain into sibling modules:
 * `schema-display.ts` (utility + display tool calls), `schema-exec.ts`
 * (exec channel), `schema-run.ts` (run request / envelopes / interaction),
 * `schema-models.ts` (AvailableModels). Registration order matters only in
 * that every `addType` runs before the root is looked up; the one root is
 * shared, so cross-module type references resolve by name exactly as before.
 */
export function createMessageTypes(): protobuf.Root {
  const root = new protobuf.Root()
  registerDisplayTypes(root)
  registerExecTypes(root)
  registerRunTypes(root)
  registerModelTypes(root)
  return root
}

// ── Singleton root ──

let _root: protobuf.Root | null = null

export function getMessageTypes(): protobuf.Root {
  if (!_root) {
    _root = createMessageTypes()
  }
  return _root
}

export function encodeMessage(typeName: string, message: Record<string, unknown>): Uint8Array {
  const root = getMessageTypes()
  const type = root.lookupType(typeName)
  const err = type.verify(message)
  if (err) throw new Error(`Invalid message for ${typeName}: ${err}`)
  return type.encode(type.fromObject(message)).finish()
}

export function decodeMessage<T = Record<string, unknown>>(
  typeName: string,
  data: Uint8Array,
): T {
  const root = getMessageTypes()
  const type = root.lookupType(typeName)
  const decoded = type.decode(data)
  return type.toObject(decoded, { defaults: true, json: true, longs: Number }) as T
}
