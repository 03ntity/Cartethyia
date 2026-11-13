// Freebuff official tool schema chunk 02 of 05, embedded verbatim.
//
// LOCKED: tests/provider-probing fixtures assert these bytes match the donor
// assets, so do not reformat or reorder. Concatenated into
// FREEBUFF_OFFICIAL_TOOLS by ./freebuff-tools in chunk order.
//
import type { FreebuffOfficialTool } from "./freebuff-tools-types";

export const FREEBUFF_TOOLS_CHUNK_02: readonly FreebuffOfficialTool[] = [
  {
    "type": "function",
    "function": {
      "name": "write_todos",
      "description": "Use this tool to track your objectives through an ordered step-by-step plan. Call this tool after you have gathered context on the user's request to plan out the implementation steps for the user's request.\n\nAfter completing each todo step, call this tool again to update the list and mark that task as completed. Note that each time you call this tool, rewrite ALL todos with their current status.\n\nUse this tool frequently as you work through tasks to update the list of todos with their current status. Doing this is extremely useful because it helps you stay on track and complete all the requirements of the user's request. It also helps inform the user of your plans and the current progress, which they want to know at all times.\n\nExample:\n<write_todos_params_example>\n{\n  \"todos\": [\n    {\n      \"task\": \"Create new implementation in foo.ts\",\n      \"completed\": true\n    },\n    {\n      \"task\": \"Update bar.ts to use the new implementation\",\n      \"completed\": false\n    },\n    {\n      \"task\": \"Write tests for the new implementation\",\n      \"completed\": false\n    },\n    {\n      \"task\": \"Run the tests to verify the new implementation\",\n      \"completed\": false\n    }\n  ]\n}\n</write_todos_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Write a todo list to track tasks for multi-step implementations. Use this frequently to maintain an updated step-by-step plan.",
        "type": "object",
        "properties": {
          "todos": {
            "description": "List of todos with their completion status. Add ALL of the applicable tasks to the list, so you don't forget to do anything. Try to order the todos the same way you will complete them. Do not mark todos as completed if you have not completed them yet!",
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "task": {
                  "description": "Description of the task",
                  "type": "string"
                },
                "completed": {
                  "description": "Whether the task is completed",
                  "type": "boolean"
                }
              },
              "required": [
                "task",
                "completed"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "todos"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "run_file_change_hooks",
      "description": "Purpose: Trigger client-configured file change hooks for the specified files. This tool allows the backend to request the client to run its configured file change hooks (like tests, linting, type checking) after file changes have been applied.\n\nUse cases:\n- After making code changes, trigger the relevant tests and checks\n- Ensure code quality by running configured linters and type checkers\n- Validate that changes don't break the build\n\nThe client will run only the hooks whose filePattern matches the provided files.\n\nExample:\n<run_file_change_hooks_params_example>\n{\n  \"files\": [\n    \"src/components/Button.tsx\",\n    \"src/utils/helpers.ts\"\n  ]\n}\n</run_file_change_hooks_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
          "files": {
            "description": "List of file paths that were changed and should trigger file change hooks",
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "files"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "end_turn",
      "description": "Only use this tool to hand control back to the user.\n\n- When to use: after you have completed a meaningful chunk of work and you are either (a) fully done, or (b) explicitly waiting for the user's next message.\n- Do NOT use: as a stop token mid-work, to pause between tool calls, to wait for tool results, or to \"check in\" unnecessarily.\n- Before calling: finish all pending steps, resolve tool results, and include any outputs the user needs to review.\n- Effect: Signals the UI to wait for the user's reply; any pending tool results will be ignored.\n\n*INCORRECT USAGE*:\n<some_tool_that_produces_results_params_example>\n{\n  \"query\": \"some example search term\"\n}\n</some_tool_that_produces_results_params_example>\n\n<end_turn_params_example>\n{}\n</end_turn_params_example>\n\n*CORRECT USAGE*:\nAll done! Would you like some more help with xyz?\n\n<end_turn_params_example>\n{}\n</end_turn_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "End your turn, regardless of any new tool results that might be coming. This will allow the user to type another prompt.",
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "web_search",
      "description": "Purpose: Search the web for current, up-to-date information on any topic. This tool uses Serper's Google Search API to find relevant content from across the internet.\n\nUse cases:\n- Finding current information about technologies, libraries, or frameworks\n- Researching best practices and solutions\n- Getting up-to-date news or documentation\n- Finding examples and tutorials\n- Checking current status of services or APIs\n\nThe tool will return JSON search results with titles, URLs, content snippets, and other available SERP fields such as answer boxes or related questions.\n\nExample:\n<web_search_params_example>\n{\n  \"query\": \"Next.js 15 new features\",\n  \"depth\": \"standard\"\n}\n</web_search_params_example>\n\n<web_search_params_example>\n{\n  \"query\": \"React Server Components tutorial\",\n  \"depth\": \"deep\"\n}\n</web_search_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Search the web for current information using Serper API.",
        "type": "object",
        "properties": {
          "query": {
            "description": "The search query to find relevant web content",
            "type": "string",
            "minLength": 1
          },
          "depth": {
            "description": "Search depth - 'standard' for quick results, 'deep' for more comprehensive search. Default is 'standard'.",
            "default": "standard",
            "type": "string",
            "enum": [
              "standard",
              "deep"
            ]
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read_url",
      "description": "Purpose: Fetch a URL returned by web_search and extract the readable page text so you can answer with source-backed evidence.\n\nUse this after web_search when snippets are not enough. Prefer authoritative, relevant pages from the search results. The tool follows redirects, extracts titles and metadata, strips scripts/styles/navigation boilerplate from HTML, and returns normalized readable text.\n\nDo not use run_terminal_command with curl just to inspect web pages; use read_url instead. If read_url reports unsupported content or extraction failure, then choose a different search result or explain the limitation.\n\nExample:\n<read_url_params_example>\n{\n  \"url\": \"https://react.dev/reference/react/useActionState\",\n  \"max_chars\": 12000\n}\n</read_url_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Fetch a URL and extract readable text from the page.",
        "type": "object",
        "properties": {
          "url": {
            "description": "The full http:// or https:// URL to fetch and extract readable text from.",
            "type": "string",
            "format": "uri"
          },
          "max_chars": {
            "description": "Maximum number of extracted text characters to return. Defaults to 20000.",
            "default": 20000,
            "type": "integer",
            "minimum": 1000,
            "maximum": 50000
          }
        },
        "required": [
          "url"
        ],
        "additionalProperties": false
      }
    }
  }
];
