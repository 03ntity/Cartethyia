// Freebuff official tool schema chunk 01 of 05, embedded verbatim.
//
// LOCKED: tests/provider-probing fixtures assert these bytes match the donor
// assets, so do not reformat or reorder. Concatenated into
// FREEBUFF_OFFICIAL_TOOLS by ./freebuff-tools in chunk order.
//
import type { FreebuffOfficialTool } from "./freebuff-tools-types";

export const FREEBUFF_TOOLS_CHUNK_01: readonly FreebuffOfficialTool[] = [
  {
    "type": "function",
    "function": {
      "name": "read_files",
      "description": "Example:\n<read_files_params_example>\n{\n  \"paths\": [\n    \"path/to/file1.ts\",\n    \"path/to/file2.ts\"\n  ]\n}\n</read_files_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Read files from disk. List several paths to read several files in one call. Large files are cut off after 2,000 lines, with a note telling you the file's total line count. Don't read a large file whole: use code_search to locate the part you need (matches come with line numbers), then read a window around it with { path, offset, limit }. Avoid tiny repeated slices; when in doubt, take a window of a few hundred lines.",
        "type": "object",
        "properties": {
          "paths": {
            "description": "List of files to read. Each entry is either a file path, or an object { path, offset, limit } to read a specific line range of that file.",
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "description": "File path to read. Prefer paths relative to the **project root**; absolute paths inside the project are accepted, but paths outside the project will not work.",
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "object",
                  "properties": {
                    "path": {
                      "type": "string",
                      "minLength": 1
                    },
                    "offset": {
                      "description": "Line number to start reading from (1-indexed).",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "limit": {
                      "description": "Maximum number of lines to read (defaults to 2,000).",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "path"
                  ],
                  "additionalProperties": false
                }
              ]
            }
          }
        },
        "required": [
          "paths"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "str_replace",
      "description": "Use this tool to make edits within existing files.\n\nImportant:\nIf you are making multiple edits in a row to a file, use only one str_replace call with multiple replacements instead of multiple str_replace tool calls.\n\nExample:\n<str_replace_params_example>\n{\n  \"path\": \"path/to/file\",\n  \"replacements\": [\n    {\n      \"oldString\": \"This is the old string\",\n      \"newString\": \"This is the new string\"\n    },\n    {\n      \"oldString\": \"\\n\\t\\t// @codebuff delete this log line please\\n\\t\\tconsole.log(\\\"Hello, world!\\\");\\n\",\n      \"newString\": \"\\n\"\n    },\n    {\n      \"oldString\": \"\\nfoo:\",\n      \"newString\": \"\\nbar:\",\n      \"allowMultiple\": true\n    }\n  ]\n}\n</str_replace_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Replace strings in a file with new strings.",
        "type": "object",
        "properties": {
          "path": {
            "description": "The path to the file to edit.",
            "type": "string",
            "minLength": 1
          },
          "replacements": {
            "description": "Array of replacements to make.",
            "minItems": 1,
            "type": "array",
            "items": {
              "description": "Pair of oldString and newString values.",
              "type": "object",
              "properties": {
                "oldString": {
                  "description": "The string to replace. This must be an *exact match* of the string you want to replace, including whitespace and punctuation.",
                  "type": "string",
                  "minLength": 1
                },
                "newString": {
                  "description": "The string to replace the corresponding oldString with. Can be empty to delete.",
                  "type": "string"
                },
                "allowMultiple": {
                  "description": "Whether to allow multiple replacements of oldString.",
                  "default": false,
                  "type": "boolean"
                }
              },
              "required": [
                "oldString",
                "newString"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "path",
          "replacements"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_file",
      "description": "Create or replace a file with the given content.\n\nFormat the `content` parameter with the entire content of the file.\n\n#### Additional Info\n\nDo not use this tool to delete or rename a file. Instead run a terminal command for that.\n\nExamples:\n\nExample 1 - Simple file creation:\n<write_file_params_example>\n{\n  \"path\": \"new-file.ts\",\n  \"instructions\": \"Prints Hello, world\",\n  \"content\": \"console.log(\\\"Hello, world!\\\");\"\n}\n</write_file_params_example>\n\nExample 2 - Overwriting a file:\n<write_file_params_example>\n{\n  \"path\": \"foo.ts\",\n  \"instructions\": \"Update foo function\",\n  \"content\": \"function foo() {\\n  doSomethingNew();\\n}\\n  \\nfunction bar() {\\n  doSomethingOld();\\n}\\n\"\n}\n</write_file_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Create or overwrite a file with the given content.",
        "type": "object",
        "properties": {
          "path": {
            "description": "Path to the file relative to the **project root**",
            "type": "string",
            "minLength": 1
          },
          "instructions": {
            "description": "What the change is intended to do in only one sentence.",
            "type": "string"
          },
          "content": {
            "description": "Complete file content to write to the file.",
            "type": "string"
          }
        },
        "required": [
          "path",
          "instructions",
          "content"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "run_terminal_command",
      "description": "Stick to these use cases:\n1. Typechecking the project or running build (e.g., \"npm run build\"). Reading the output can help you edit code to fix build errors. If possible, use an option that performs checks but doesn't emit files, e.g. `tsc --noEmit`.\n2. Running tests (e.g., \"npm test\"). Reading the output can help you edit code to fix failing tests. Or, you could write new unit tests and then run them.\n3. Moving, renaming, or deleting files and directories. These actions can be vital for refactoring requests. Use `mv` or `rm` (commands run in bash on every OS, including Windows — do not use `move`/`del`).\n\nMost likely, you should ask for permission for any other type of command you want to run. If asking for permission, show the user the command you want to run using ``` tags and *do not* use the tool call format, e.g.:\n```bash\ngit branch -D foo\n```\n\nDO NOT do any of the following:\n1. Run commands that can modify files outside of the project directory, install packages globally, install virtual environments, or have significant side effects outside of the project directory, unless you have explicit permission from the user. Treat anything outside of the project directory as read-only.\n2. Run `git push` because it can break production (!) if the user was not expecting it. Don't run `git commit`, `git rebase`, or related commands unless you get explicit permission. If a user asks to commit changes, you can do so, but you should not invoke any further git commands beyond the git commit command.\n3. Run scripts without asking. Especially don't run scripts that could run against the production environment or have permanent effects without explicit permission from the user.\n4. Be careful with any command that has big or irreversible effects. Anything that touches a production environment, servers, the database, or other systems that could be affected by a command should be run with explicit permission from the user.\n5. Use the run_terminal_command tool to create or edit files. Do not use `cat` or `echo` to create or edit files. You should instead use other tools for creating or editing files.\n6. Use the wrong package manager for the project. For example, if the project uses `pnpm` or `bun` or `yarn`, you should not use `npm`. Similarly not everyone uses `pip` for python, etc.\n\nDo:\n- If there's an opportunity to use \"-y\" or \"--yes\" flags, use them. Any command that prompts for confirmation will hang if you don't use the flags.\n\nNotes:\n- If the user references a specific file, it could be either from their cwd or from the project root. You **must** determine which they are referring to (either infer or ask). Then, you must specify the path relative to the project root (or use the cwd parameter)\n- Commands can succeed without giving any output, e.g. if no type errors were found.\n\n\n### Using git to commit changes\n\nWhen the user requests a new git commit, please follow these steps closely:\n\n1. **Run two run_terminal_command tool calls:**\n   - Run `git diff` to review both staged and unstaged modifications.\n   - Run `git log` to check recent commit messages, ensuring consistency with this repository's style.\n\n2. **Select relevant files to include in the commit:**\n   Use the git context established at the start of this conversation to decide which files are pertinent to the changes. Stage any new untracked files that are relevant, but avoid committing previously modified files (from the beginning of the conversation) unless they directly relate to this commit.\n\n3. **Analyze the staged changes and compose a commit message:**\n   Enclose your analysis in <commit_analysis> tags. Within these tags, you should:\n   - Note which files have been altered or added.\n   - Categorize the nature of the changes (e.g., new feature, fix, refactor, documentation, etc.).\n   - Consider the purpose or motivation behind the alterations.\n   - Refrain from using tools to inspect code beyond what is presented in the git context.\n   - Evaluate the overall impact on the project.\n   - Check for sensitive details that should not be committed.\n   - Draft a concise, one- to two-sentence commit message focusing on the “why” rather than the “what.”\n   - Use precise, straightforward language that accurately represents the changes.\n   - Ensure the message provides clarity—avoid generic or vague terms like “Update” or “Fix” without context.\n   - Revisit your draft to confirm it truly reflects the changes and their intention.\n\n4. **Create the commit, ending with this specific footer:**\n   ```\n   Generated with Codebuff 🤖\n   Co-Authored-By: Codebuff <noreply@codebuff.com>\n   ```\n   Commands run in bash on every OS (Git Bash on Windows), so always use HEREDOC syntax to format the message:\n   ```\n   git commit -m \"$(cat <<'EOF'\n   Your commit message here.\n\n   🤖 Generated with Codebuff\n   Co-Authored-By: Codebuff <noreply@codebuff.com>\n   EOF\n   )\"\n   ```\n\n**Important details**\n\n- When feasible, use a single `git commit -am` command to add and commit together, but do not accidentally stage unrelated files.\n- Never alter the git config.\n- Do not push to the remote repository.\n- Avoid using interactive flags (e.g., `-i`) that require unsupported interactive input.\n- Do not create an empty commit if there are no changes.\n- Make sure your commit message is concise yet descriptive, focusing on the intention behind the changes rather than merely describing them.\n\n\nExample:\n<run_terminal_command_params_example>\n{\n  \"command\": \"echo \\\"hello world\\\"\"\n}\n</run_terminal_command_params_example>\n\n<run_terminal_command_params_example>\n{\n  \"command\": \"git commit -m \\\"Your commit message here.\\n\\n🤖 Generated with Codebuff\\nCo-Authored-By: Codebuff <noreply@codebuff.com>\\\"\"\n}\n</run_terminal_command_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Execute a CLI command from the **project root** (different from the user's cwd).",
        "type": "object",
        "properties": {
          "command": {
            "description": "CLI command. Always executed with bash (Git Bash on Windows), so use POSIX syntax on every OS: `mv`/`rm`, `/dev/null`, heredocs. Never use cmd.exe syntax like `del`, `move`, or `> nul` — on Windows `> nul` creates a literal file named \"nul\" that is very hard to delete.",
            "type": "string",
            "minLength": 1
          },
          "process_type": {
            "description": "Either SYNC (waits, returns output) or BACKGROUND (runs in background). Default SYNC",
            "default": "SYNC",
            "type": "string",
            "enum": [
              "SYNC",
              "BACKGROUND"
            ]
          },
          "cwd": {
            "description": "The working directory to run the command in. Default is the project root.",
            "type": "string"
          },
          "timeout_seconds": {
            "description": "How long to wait, in seconds. Default 30, which is right for almost everything — omit this field unless the command genuinely runs longer. Budget for the command you are actually running (a typecheck or test run is tens of seconds, not minutes); an over-long value does not make a command safer, it just means you wait that long when something hangs. Values above 600 (10 minutes) are clamped. Set to -1 to wait indefinitely, for genuinely open-ended commands only. Does not apply for BACKGROUND commands — use those for long-running processes instead.",
            "default": 30,
            "type": "number"
          }
        },
        "required": [
          "command"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "code_search",
      "description": "Purpose: Search through code files to find files with specific text patterns, function names, variable names, and more.\n\nMatches are returned with their line numbers, so in a large file you can search first and then read a window around a match with read_files { path, offset, limit } instead of reading the whole file.\n\nUse cases:\n1. Finding all references to a function, class, or variable name across the codebase\n2. Searching for specific code patterns or implementations\n3. Looking up where certain strings or text appear\n4. Finding files that contain specific imports or dependencies\n5. Locating configuration settings or environment variables\n\nThe pattern supports regular expressions and will search recursively through all files in the project by default. Some tips:\n- Be as constraining in the pattern as possible to limit the number of files returned, e.g. if searching for the definition of a function, use \"(function foo|const foo)\" or \"def foo\" instead of merely \"foo\".\n- Use Rust-style regex, not grep-style, PCRE, RE2 or JavaScript regex - you must always escape special characters like { and }\n- Be as constraining as possible to limit results, e.g. use \"(function foo|const foo)\" or \"def foo\" instead of merely \"foo\"\n- Add context to your search with surrounding terms (e.g., \"function handleAuth\" rather than just \"handleAuth\")\n- Use word boundaries (\\b) to match whole words only\n- Use the cwd parameter to narrow your search to specific directories\n- For case-sensitive searches like constants (e.g., ERROR vs error), omit the \"-i\" flag\n- Searches file content and filenames\n- Automatically ignores binary files, hidden files, and files in .gitignore\n\n\nAdvanced ripgrep flags (use the flags parameter):\n\n- Case sensitivity: \"-i\" for case-insensitive search\n- File type filtering: \"-t ts -t js\" (TypeScript and JavaScript), \"-t py\" (Python), etc.\n- Exclude file types: \"--type-not py\" to exclude Python files\n- Context lines: \"-A 3\" (3 lines after), \"-B 2\" (2 lines before), \"-C 2\" (2 lines before and after)\n- Line numbers: \"-n\" to show line numbers\n- Count matches: \"-c\" to count matches per file\n- Only filenames: \"-l\" to show only filenames with matches\n- Invert match: \"-v\" to show lines that don't match\n- Word boundaries: \"-w\" to match whole words only\n- Fixed strings: \"-F\" to treat pattern as literal string (not regex)\n\nNote: Do not use the end_turn tool after this tool! You will want to see the output of this tool before ending your turn.\n\nRESULT LIMITING:\n\n- The maxResults parameter limits the number of results shown per file (default: 15)\n- There is also a global limit of 250 total results across all files\n- These limits allow you to see results across multiple files without being overwhelmed by matches in a single file\n- If a file has more matches than maxResults, you'll see a truncation notice indicating how many results were found\n- If the global limit is reached, remaining files will be skipped\n\nExamples:\n<code_search_params_example>\n{\n  \"pattern\": \"foo\"\n}\n</code_search_params_example>\n<code_search_params_example>\n{\n  \"pattern\": \"foo\\\\.bar = 1\\\\.0\"\n}\n</code_search_params_example>\n<code_search_params_example>\n{\n  \"pattern\": \"import.*foo\",\n  \"cwd\": \"src\"\n}\n</code_search_params_example>\n<code_search_params_example>\n{\n  \"pattern\": \"function.*authenticate\",\n  \"flags\": \"-i -t ts -t js\"\n}\n</code_search_params_example>\n<code_search_params_example>\n{\n  \"pattern\": \"TODO\",\n  \"flags\": \"-n --type-not py\"\n}\n</code_search_params_example>\n<code_search_params_example>\n{\n  \"pattern\": \"getUserData\",\n  \"maxResults\": 10\n}\n</code_search_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Search for string patterns in the project's files. This tool uses ripgrep (rg), a fast line-oriented search tool.",
        "type": "object",
        "properties": {
          "pattern": {
            "description": "The pattern to search for.",
            "type": "string",
            "minLength": 1
          },
          "flags": {
            "description": "Optional ripgrep flags to customize the search (e.g., \"-i\" for case-insensitive, \"-g *.ts -g *.js\" for TypeScript and JavaScript files only, \"-g !*.test.ts\" to exclude Typescript test files,  \"-A 3\" for 3 lines after match, \"-B 2\" for 2 lines before match).",
            "type": "string"
          },
          "cwd": {
            "description": "Optional working directory to search within, relative to the project root. Defaults to searching the entire project.",
            "type": "string"
          },
          "maxResults": {
            "description": "Maximum number of results to return per file. Defaults to 15. There is also a global limit of 250 results across all files.",
            "default": 15,
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "pattern"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "glob",
      "description": "Example:\n<glob_params_example>\n{\n  \"pattern\": \"**/*.test.ts\"\n}\n</glob_params_example>\n\nPurpose: Search for files matching a glob pattern to discover files by name patterns rather than content.\nUse cases:\n- Find all files with a specific extension (e.g., \"*.js\", \"*.test.ts\")\n- Locate files in specific directories (e.g., \"src/**/*.ts\")\n- Find files with specific naming patterns (e.g., \"**/test_*.go\", \"**/*-config.json\")\n- Discover test files, configuration files, or other files with predictable naming\n\nGlob patterns support:\n- * matches any characters except /\n- ** matches any characters including /\n- ? matches a single character\n- [abc] matches one of the characters in brackets\n- {a,b} matches one of the comma-separated patterns\n\nThis tool is fast and works well for discovering files by name patterns.",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "Search for files matching a glob pattern. Returns matching file paths sorted by modification time.",
        "type": "object",
        "properties": {
          "pattern": {
            "description": "Glob pattern to match files against (e.g., *.js, src/glob/*.ts, glob/test/glob/*.go).",
            "type": "string",
            "minLength": 1
          },
          "cwd": {
            "description": "Optional working directory to search within, relative to project root. If not provided, searches from project root.",
            "type": "string"
          },
          "max_results": {
            "description": "Maximum number of matching paths to return.",
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "pattern"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "list_directory",
      "description": "Lists all files and directories in the specified path. Useful for exploring directory structure and finding files.\n\nExample:\n<list_directory_params_example>\n{\n  \"path\": \"src/components\"\n}\n</list_directory_params_example>\n\n<list_directory_params_example>\n{\n  \"path\": \".\"\n}\n</list_directory_params_example>",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "description": "List files and directories in the specified path. Returns separate arrays of file names and directory names.",
        "type": "object",
        "properties": {
          "path": {
            "description": "Directory path to list, relative to the project root.",
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      }
    }
  }
];
