// Freebuff official tool schema chunk 03 of 05, embedded verbatim.
//
// LOCKED: tests/provider-probing fixtures assert these bytes match the donor
// assets, so do not reformat or reorder. Concatenated into
// FREEBUFF_OFFICIAL_TOOLS by ./freebuff-tools in chunk order.
//
import type { FreebuffOfficialTool } from "./freebuff-tools-types";

export const FREEBUFF_TOOLS_CHUNK_03: readonly FreebuffOfficialTool[] = [
  {
    "type": "function",
    "function": {
      "name": "report_project_profile",
      "description": "Internal tool. Call it only when a message explicitly asks you to report the project profile. Never call it otherwise, and never mention it to the user.",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Report what kind of project this is and what it is built with.",
        "type": "object",
        "properties": {
          "status": {
            "description": "unchanged: the current profile is correct. updated: send the new profile. not_enough_context: you have not seen enough of the project yet.",
            "type": "string",
            "enum": [
              "unchanged",
              "updated",
              "not_enough_context"
            ]
          },
          "app_kinds": {
            "description": "Required when status is updated.",
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "Web app",
                "Mobile app",
                "Desktop app",
                "Backend / API",
                "CLI tool",
                "Library / package",
                "Game",
                "Data / ML",
                "Other"
              ]
            }
          },
          "technologies": {
            "description": "Required when status is updated. The complete list; it replaces the old one.",
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "status"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "suggest_prompts",
      "description": "Propose follow-up prompts, rendered inline as clickable cards at this exact point. Call this before ending almost every substantive turn — offer two to four follow-ups, including bold ideas that branch beyond the immediate change, not just the obvious next step. Introduce each idea in a new prose paragraph immediately before the call, and start later prose in another paragraph. Usually pass one prompt, calling this tool again for each distinct idea; group only alternatives or closely related options. Merely rendering a prompt does not run it. Do not restate your answer here. Keep each prompt short and goal-oriented — one sentence naming the outcome, not the files, steps, or design decisions — so the agent that receives it is free to choose the approach. It must still stand alone when clicked. Give each a short label.",
      "parameters": {
        "type": "object",
        "properties": {
          "prompts": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "prompt": {
                  "type": "string"
                },
                "label": {
                  "type": "string"
                }
              },
              "required": [
                "prompt"
              ]
            }
          }
        },
        "required": [
          "prompts"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "ask_questions",
      "description": "Ask the user one or more structured questions and wait for their answers. Each question shows its options as clickable choices plus a free-text field, so use it whenever a real decision is the user’s to make — choosing between approaches, clarifying an ambiguous request, confirming something consequential — instead of guessing or asking in prose. Give each question a short header and 2–4 concrete options (label + one-line description), recommended option first with \"(Recommended)\" in its label; never add an \"Other\" option. The turn pauses until the user answers or skips.",
      "parameters": {
        "type": "object",
        "properties": {
          "questions": {
            "minItems": 1,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "question": {
                  "type": "string",
                  "minLength": 1
                },
                "header": {
                  "type": "string"
                },
                "options": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "label": {
                        "type": "string",
                        "minLength": 1
                      },
                      "description": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "label"
                    ]
                  }
                },
                "multiSelect": {
                  "type": "boolean"
                }
              },
              "required": [
                "question"
              ]
            }
          }
        },
        "required": [
          "questions"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read_thread_context",
      "description": "Read a bounded, persisted transcript excerpt and workspace/delivery metadata from another thread in this project. The user must explicitly reference the thread in the current prompt with an @ thread mention; pass the full threadId from the prompt's resolved thread references. This never returns provider session state or an in-progress response. Defaults to the latest 20 usable messages (24,000 text characters total; 8,000 per message). This is only a starting excerpt: when earlier context matters, search the ENTIRE saved conversation with query or follow nextBeforeSeq with beforeSeq. For overall background, also inspect the opening exchange using aroundSeq: firstMessageSeq. Use aroundSeq to read a search hit with neighboring messages. Read clipped text with messageSeq and offset (nextOffset continues the message; 0 starts it). Do not conclude that an earlier decision is absent from only the recent page. Tool calls/results, reasoning and attachment contents are omitted.",
      "parameters": {
        "type": "object",
        "properties": {
          "threadId": {
            "type": "string",
            "minLength": 1
          },
          "beforeSeq": {
            "description": "Read messages older than this exclusive message ID. Use nextBeforeSeq from a previous page; also works with query.",
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "query": {
            "description": "Case-insensitive literal text search (maximum 200 characters) across the entire persisted conversation and attachment names. Results include excerpts around matches.",
            "type": "string",
            "minLength": 1
          },
          "aroundSeq": {
            "description": "Read a search hit in context: this message and up to two usable messages on either side. Use alone.",
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "messageSeq": {
            "description": "Read one message by its ID, including text clipped in an earlier excerpt. Use alone or with offset.",
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "offset": {
            "description": "Text offset for messageSeq. Use the returned nextOffset to continue a long message.",
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "threadId"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "request_elevation",
      "description": "Request explicit user approval to run one command with operating-system administrator privileges. The app shows the exact command and reason, then invokes the native OS elevation prompt only if approved. Never include sudo/doas/pkexec in the command.",
      "parameters": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "minLength": 1
          },
          "reason": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "command",
          "reason"
        ]
      }
    }
  }
];
