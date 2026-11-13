// Freebuff official tool schema chunk 05 of 05, embedded verbatim.
//
// LOCKED: tests/provider-probing fixtures assert these bytes match the donor
// assets, so do not reformat or reorder. Concatenated into
// FREEBUFF_OFFICIAL_TOOLS by ./freebuff-tools in chunk order.
//
import type { FreebuffOfficialTool } from "./freebuff-tools-types";

export const FREEBUFF_TOOLS_CHUNK_05: readonly FreebuffOfficialTool[] = [
  {
    "type": "function",
    "function": {
      "name": "preview_snapshot",
      "description": "Read this thread's running preview page as a text accessibility tree. Each interactive node carries a `uid=` handle that preview_click / preview_type accept. Uids expire whenever the page changes (navigation, re-render, or a newer snapshot) — take a fresh snapshot before acting if in doubt. Open a browser with preview_open or register_preview. Omit tabId for the active tab in the desktop app.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_screenshot",
      "description": "Capture a PNG screenshot of this thread's running preview page. Use it to SEE what the user sees — layout, styling, rendering glitches that no DOM reading reveals. Captures the viewport; fullPage tries for the whole scrollable page but often degrades to the viewport (it needs the page to hold still), so scroll with preview_evaluate to survey a long page.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "fullPage": {
            "type": "boolean"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_click",
      "description": "Click an element in the running preview page, addressed by a `uid` from the latest preview_snapshot, or a Playwright locator (e.g. role=button[name=\"Save\"]). Provide exactly one. Scrolls the element into view first. A stale-uid error means the page changed — re-snapshot and retry with a fresh uid. If the click navigates, this waits for the new page to load and answers `navigated: true` with its url; the DOM is then current, but rendering can lag it briefly, so trust preview_snapshot over an immediate screenshot.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "uid": {
            "type": "string"
          },
          "locator": {
            "type": "string"
          },
          "dblClick": {
            "type": "boolean"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_type",
      "description": "Type text into a browser element using uid from preview_snapshot OR a Playwright locator. Focuses the element, clears its current value by default (clear:false to append), inserts the text through real input events, and optionally presses Enter to submit.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "uid": {
            "type": "string"
          },
          "locator": {
            "type": "string"
          },
          "text": {
            "type": "string"
          },
          "clear": {
            "type": "boolean"
          },
          "pressEnter": {
            "type": "boolean"
          }
        },
        "required": [
          "text"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_navigate",
      "description": "Navigate a browser tab: `to` is an HTTP(S) URL, or one of \"reload\", \"back\", \"forward\". Waits briefly for the page to load. All previous snapshot uids become stale after navigating.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "to": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "to"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_evaluate",
      "description": "Evaluate a JavaScript expression in the running preview page and return its JSON-serialized result (promises are awaited). Use it to probe state the snapshot cannot show — computed styles, app store contents, function results. Prefer read-only expressions; use preview_click/preview_type for user-like interaction.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "expression": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "expression"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_logs",
      "description": "Read the running preview page's console messages and network requests captured since the preview attached (or since the last clear). Check this after interactions to catch errors, failed requests, and warnings the page produced.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "console",
              "network",
              "all"
            ]
          },
          "limit": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "clear": {
            "type": "boolean"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "browser_check",
      "description": "Unavailable in this build — use your normal tools (or ask the user to look at the Preview tab) instead.",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_doc",
      "description": "Unavailable in this build — write markdown files with your normal file tools instead.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "content": {
            "type": "string"
          },
          "mode": {
            "type": "string",
            "enum": [
              "append",
              "replace"
            ]
          }
        },
        "required": [
          "name",
          "content"
        ]
      }
    }
  }
];
