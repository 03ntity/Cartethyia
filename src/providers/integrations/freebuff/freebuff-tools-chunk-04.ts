// Freebuff official tool schema chunk 04 of 05, embedded verbatim.
//
// LOCKED: tests/provider-probing fixtures assert these bytes match the donor
// assets, so do not reformat or reorder. Concatenated into
// FREEBUFF_OFFICIAL_TOOLS by ./freebuff-tools in chunk order.
//
import type { FreebuffOfficialTool } from "./freebuff-tools-types";

export const FREEBUFF_TOOLS_CHUNK_04: readonly FreebuffOfficialTool[] = [
  {
    "type": "function",
    "function": {
      "name": "register_preview",
      "description": "Show content in this thread's Preview tab. Choose exactly one mode: (1) pass `url` and `pid` for a running dev server, after it answers HTTP; or (2) pass `htmlPath` for a complete local .html/.htm file inside this thread's workspace, which the app serves safely without a separate process. Dev-server URLs must be loopback addresses. Set `replace: true` only when intentionally replacing the thread's current live preview; this stops its registered server when applicable. Otherwise a live-preview conflict is rejected. Registering the live preview again re-shows it.",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string"
          },
          "pid": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "htmlPath": {
            "type": "string"
          },
          "replace": {
            "type": "boolean"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_open",
      "description": "Open a Chromium browser tab in this task, showing the same page to the user. Public HTTP(S) URLs and localhost are supported. No dev-server process is required. Returns tab id; pass it to subsequent tools. Reuse navigates the agent’s current tab or the supplied tabId instead of creating another.",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string"
          },
          "profileId": {
            "type": "string"
          },
          "incognito": {
            "type": "boolean"
          },
          "reuse": {
            "type": "boolean"
          },
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
      "name": "preview_status",
      "description": "List this task’s browser tabs and current page state.",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_close",
      "description": "Close one browser tab without stopping its dev server.",
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
      "name": "preview_press",
      "description": "Press a real browser key, e.g. Enter, Tab, Escape, ArrowDown, Control+a or Meta+a.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "key": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "key"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_scroll",
      "description": "Scroll the browser with real wheel input; x/y are pixel deltas.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_wait",
      "description": "Wait until all supplied conditions match the page: CSS selector, visible text, URL substring. Bounded and interrupted when the human takes control.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "selector": {
            "type": "string"
          },
          "text": {
            "type": "string"
          },
          "urlIncludes": {
            "type": "string"
          },
          "timeoutMs": {
            "type": "integer",
            "minimum": 100,
            "maximum": 60000
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_resize",
      "description": "Set the browser viewport in CSS pixels. Set fill:true to fill the panel instead.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "width": {
            "type": "integer",
            "minimum": 240,
            "maximum": 3840
          },
          "height": {
            "type": "integer",
            "minimum": 240,
            "maximum": 2160
          },
          "fill": {
            "type": "boolean"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_set_color_scheme",
      "description": "Emulate the page’s light/dark appearance.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          },
          "colorScheme": {
            "type": "string",
            "enum": [
              "system",
              "light",
              "dark"
            ]
          }
        },
        "required": [
          "colorScheme"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "preview_recording_start",
      "description": "Record this browser tab as a local WebM video (up to five minutes).",
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
      "name": "preview_recording_stop",
      "description": "Stop recording and return the local video artifact path.",
      "parameters": {
        "type": "object",
        "properties": {
          "tabId": {
            "type": "string"
          }
        }
      }
    }
  }
];
