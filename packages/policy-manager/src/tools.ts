import type { Request } from "./types.js";

/**
 * Tools the engine judges itself: shell, file, patch and command-running tools. They are never
 * approved by default and always get the engine's checks. MCP tools (`mcp__*`) follow
 * `mcpReadOnly` instead.
 */
export const ENGINE_TOOLS = new Set(
  [
    "Bash",
    "bash",
    "powershell",
    "exec_command",
    "shell",
    "apply_patch",
    "Read",
    "view",
    "read_file",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "edit",
    "create",
    "write_file",
    "str_replace_editor",
    // Read file contents or names, so they can reach credential paths.
    "Grep",
    "Glob",
    "LS",
    "NotebookRead",
    "view_image",
    // Runs a shell command in the background.
    "Monitor",
  ].map((name) => name.toLowerCase()),
);

/**
 * Harness tools that are never approved by default and keep the classification path. Empty for
 * now; a profile adds names through `toolsDeny`.
 */
export const BUILTIN_TOOLS_DENY: Record<Request["harness"], ReadonlySet<string>> = {
  claude: new Set(),
  codex: new Set(),
  copilot: new Set(),
};

/** A harness tool name a profile may list. */
export const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Whether a tool is approved by default: not an engine or MCP tool, and not denied. */
export function defaultAllowed(
  harness: Request["harness"],
  tool: string,
  deny: readonly string[],
): boolean {
  return (
    TOOL_NAME.test(tool) &&
    !ENGINE_TOOLS.has(tool.toLowerCase()) &&
    !tool.toLowerCase().startsWith("mcp__") &&
    !BUILTIN_TOOLS_DENY[harness]?.has(tool) &&
    !deny.includes(tool)
  );
}
