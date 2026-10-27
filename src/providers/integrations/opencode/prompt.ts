/**
 * The official OpenCode CLI system prompt, ported 1:1 from the opencode2api
 * reference gateway (`internal/gateway/opencode_prompt_v2.txt`,
 * `opencode_prompt.go`).
 *
 * The free-tier gate expects the agent-shaped system prompt the official CLI
 * sends. A body that already carries the marker (`carriesOpenCodePrompt`) is
 * left untouched so repeated shaping cannot duplicate it.
 */

/** Exact v2 prompt text from the donor (OpenCode 2.x tool names). */
const OPENCODE_PROMPT_V2 = `You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

If the user asks for help or wants to give feedback inform them of the following:
- /help: Get help with using opencode
- To give feedback, users should report the issue at https://github.com/anomalyco/opencode/issues

When the user directly asks about opencode (eg 'can opencode do...', 'does opencode have...') or asks in second person (eg 'are you able...', 'can you do...'), first use the webfetch tool to gather information to answer the question from opencode docs at https://opencode.ai

# Tone and style
You should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it, to make sure the user understands what you are doing (this is especially important when you are running a command that will make changes to the user's system).
Remember that your output will be displayed on a command line interface. Your responses can use GitHub-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like shell or code comments as means to communicate with the user during the session.
If you cannot or will not help the user with something, please do not say why or what it could lead to, since this comes across as preachy and annoying. Please offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences.
Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request. If you can answer in 1-3 sentences or a short paragraph, please do.
IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.
IMPORTANT: Keep your responses short, since they will be displayed on a command line interface. You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as "The answer is <answer>.", "Here is the content of the file..." or "Based on the information provided, the answer is..." or "Here is what I will do next...". Here are some examples to demonstrate appropriate verbosity:
<example>
user: what is 2+2?
assistant: 4
</example>

<example>
user: is 11 a prime number?
assistant: Yes
</example>

<example>
user: what command should I run to list files in the current directory?
assistant: ls
</example>

<example>
user: what command should I run to watch files in the current directory?
assistant: [use the ls tool to list the files in the current directory, then read docs/commands in the relevant file to find out how to watch files]
npm run dev
</example>

<example>
user: what files are in the directory src/?
assistant: [runs ls and sees foo.c, bar.c, baz.c]
user: which file contains the implementation of foo?
assistant: src/foo.c
</example>

<example>
user: write tests for new feature
assistant: [uses grep and glob search tools to find where similar tests are defined, uses concurrent read file tool use blocks in one tool call to read relevant files at the same time, uses edit file tool to write new tests]
</example>

# Proactiveness
You are allowed to be proactive, but only when the user asks you to do something. You should strive to strike a balance between:
1. Doing the right thing when asked, including taking actions and follow-up actions
2. Not surprising the user with actions you take without asking
For example, if the user asks you how to approach something, you should do your best to answer their question first, and not immediately jump into taking actions.
3. Do not add additional code explanation summary unless requested by the user. After working on a file, just stop, rather than providing an explanation of what you did.

# Following conventions
When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library. For example, you might look at neighboring files, or check the package.json (or cargo.toml, and so on depending on the language).
- When you create a new component, first look at existing components to see how they're written; then consider framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries. Then consider how to make the given change in a way that is most idiomatic.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository.

# Code style
- IMPORTANT: DO NOT ADD ***ANY*** COMMENTS unless asked

# Doing tasks
The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:
- Use the available search tools to understand the codebase and the user's query. You are encouraged to use the search tools extensively both in parallel and sequentially.
- Implement the solution using all tools available to you
- Verify the solution if possible with tests. NEVER assume specific test framework or test script. Check the README or search codebase to determine the testing approach.
- VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck, ruff, etc.) with shell if they were provided to you to ensure your code is correct. If you are unable to find the correct command, ask the user for the command to run and if they supply it, proactively suggest writing it to AGENTS.md so that you will know to run it next time.
NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.

- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are NOT part of the user's provided input or the tool result.

# Tool usage policy
- When doing file search, prefer to use the subagent tool in order to reduce context usage.
- You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. When making multiple bash tool calls, you MUST send a single message with multiple tools calls to run the calls in parallel. For example, if you need to run "git status" and "git diff", send a single message with two tool calls to run the calls in parallel.

You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail.

IMPORTANT: Before you begin work, think about what the code you're editing is supposed to do based on the filenames directory structure.

# Code References

When referencing specific functions or pieces of code include the pattern \`file_path:line_number\` to allow the user to easily navigate to the source code location.

<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the \`connectToServer\` function in src/services/process.ts:712.
</example>
`;

/** The marker that identifies a body already carrying the official CLI prompt. */
export const OPENCODE_PROMPT_MARKER = "You are opencode, an interactive CLI tool";

/** The built-in skill listing the CLI appends after its environment block. */
const OPENCODE_SKILLS = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>customize-opencode</name>
    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`;

/** Formats a UTC date in Go's `Mon Jan 02 2006` shape. */
function utcStamp(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${day} ${date.getUTCFullYear()}`;
}

/** The `<env>` block the CLI puts after its base prompt. */
function opencodeEnvironment(model: string): string {
  const apiModel = model.replace(/^opencode\//, "").trim() || "unknown";
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const directory = process.cwd().trim() || "/workspace";
  return [
    `You are powered by the model named ${apiModel}. The exact model ID is opencode/${apiModel}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    "  Is directory a git repo: yes",
    `  Platform: ${platform}`,
    `  Today's date: ${utcStamp(new Date())}`,
    "</env>",
  ].join("\n");
}

/** Assembles the full CLI system prompt for a model. */
export function opencodeSystemPrompt(model: string): string {
  return OPENCODE_PROMPT_V2 + opencodeEnvironment(model) + "\n" + OPENCODE_SKILLS;
}

/** Flattens a system/instruction value into its text fragments. */
export function textFragments(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() === "" ? [] : [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => textFragments(item));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["text"] === "string") return textFragments(record["text"]);
    if (record["content"] !== undefined) return textFragments(record["content"]);
  }
  return [];
}

/** Whether any text inside `value` already contains the official prompt marker. */
export function carriesOpenCodePrompt(value: unknown): boolean {
  return textFragments(value).some((part) => part.includes(OPENCODE_PROMPT_MARKER));
}

/**
 * Folds every system/developer message into one leading system message and
 * prepends the official prompt (donor `injectChatPrompt`). Client instructions
 * keep their order and are separated by a blank line.
 */
export function injectChatPrompt(payload: Record<string, unknown>, prompt: string): boolean {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return false;
  const kept: unknown[] = [];
  const instructions: string[] = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) {
      kept.push(raw);
      continue;
    }
    const message = raw as Record<string, unknown>;
    const role = message["role"];
    if (role !== "system" && role !== "developer") {
      kept.push(raw);
      continue;
    }
    if (carriesOpenCodePrompt(message["content"])) return false;
    for (const part of textFragments(message["content"])) {
      const trimmed = part.trim();
      if (trimmed !== "") instructions.push(trimmed);
    }
  }
  let system = prompt;
  const joined = instructions.join("\n");
  if (joined !== "") system += "\n\n" + joined;
  payload["messages"] = [{ role: "system", content: system }, ...kept];
  return true;
}

/** Prepends the prompt to the top-level Anthropic `system` value. */
export function injectAnthropicPrompt(payload: Record<string, unknown>, prompt: string): boolean {
  const system = payload["system"];
  if (system !== undefined && carriesOpenCodePrompt(system)) return false;
  if (system === undefined) {
    payload["system"] = prompt;
    return true;
  }
  if (typeof system === "string") {
    payload["system"] = system.trim() === "" ? prompt : prompt + "\n\n" + system;
  } else if (Array.isArray(system)) {
    payload["system"] = [{ type: "text", text: prompt }, ...system];
  } else {
    payload["system"] = prompt;
  }
  return true;
}

/** Prepends the prompt to the Responses `instructions` value. */
export function injectResponsesPrompt(payload: Record<string, unknown>, prompt: string): boolean {
  const instructions = payload["instructions"];
  if (instructions !== undefined && carriesOpenCodePrompt(instructions)) return false;
  if (typeof instructions === "string") {
    payload["instructions"] = instructions.trim() === "" ? prompt : prompt + "\n\n" + instructions;
  } else {
    payload["instructions"] = prompt;
  }
  return true;
}

/**
 * Injects the official CLI system prompt into a free-tier payload for the given
 * wire family. System One payloads are never touched. Reports whether changed.
 */
export function injectOpenCodePrompt(
  payload: Record<string, unknown>,
  wireFamily: "chat" | "responses" | "messages" | "systemone",
  model: string,
): boolean {
  if (wireFamily === "systemone") return false;
  const prompt = opencodeSystemPrompt(model);
  if (wireFamily === "chat") return injectChatPrompt(payload, prompt);
  if (wireFamily === "messages") return injectAnthropicPrompt(payload, prompt);
  return injectResponsesPrompt(payload, prompt);
}
