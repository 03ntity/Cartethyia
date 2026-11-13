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

/** AvailableModels (catalog) schema — standalone, no cross-references. */

export function registerModelTypes(root: protobuf.Root): void {
// ── AvailableModels types ──

addType(root, "AvailableModelsRequest", [])

addType(root, "AvailableModelParameterDefinition", [
  { id: 1, name: "id", type: "string" },
  { id: 2, name: "values", type: "string", repeated: true },
])

addType(root, "AvailableModelParameterValue", [
  { id: 1, name: "id", type: "string" },
  { id: 2, name: "value", type: "string" },
])

addType(root, "AvailableModelVariant", [
  { id: 1, name: "parameter_values", type: "AvailableModelParameterValue", repeated: true },
  { id: 2, name: "display_name", type: "string" },
  { id: 3, name: "is_max_mode", type: "bool" },
  { id: 4, name: "is_default_max_config", type: "bool" },
  { id: 5, name: "is_default_non_max_config", type: "bool" },
])

addType(root, "AvailableModelEntry", [
  { id: 1, name: "name", type: "string" },
  { id: 2, name: "default_on", type: "bool" },
  { id: 5, name: "supports_agent", type: "bool" },
  { id: 9, name: "supports_thinking", type: "bool" },
  { id: 10, name: "supports_images", type: "bool" },
  { id: 14, name: "supports_max_mode", type: "bool" },
  { id: 15, name: "context_token_limit", type: "int32" },
  { id: 16, name: "context_token_limit_for_max_mode", type: "int32" },
  { id: 17, name: "client_display_name", type: "string" },
  { id: 18, name: "server_model_name", type: "string" },
  { id: 29, name: "parameter_definitions", type: "AvailableModelParameterDefinition", repeated: true },
  { id: 30, name: "variants", type: "AvailableModelVariant", repeated: true },
])

addType(root, "AvailableModelsResponse", [
  { id: 1, name: "model_names", type: "string", repeated: true },
  { id: 2, name: "models", type: "AvailableModelEntry", repeated: true },
])
}
