import { isAbsolute } from "node:path";
import type { Request } from "./types.js";
export const managedHookFlag = "--agent-corpus-policy-manager-hook";
/** Seconds each managed hook may run: above the service's review wait, which covers the classifier. */
export const HOOK_TIMEOUT_SECONDS = 45;
export function hookConfig(harness: Request["harness"], cliPath: string): Record<string, unknown> {
  if (![cliPath, process.execPath].every((path) => isAbsolute(path) && !/["\r\n$`%]/.test(path)))
    throw new Error("Use a safe absolute path to the reviewed CLI installation");
  if (!["claude", "codex", "copilot"].includes(harness)) throw new Error("Unknown harness");
  const hooks: Record<string, unknown> = {};
  const matcher =
    "Bash|Read|Edit|Write|MultiEdit|NotebookEdit|apply_patch|bash|powershell|view|read_file|write_file|edit|create|exec_command|shell";
  // Copilot documents no MCP tool name format for hooks, so only Claude and Codex see MCP calls.
  const preMatcher = harness === "copilot" ? matcher : `${matcher}|mcp__.*`;
  const phases = [
    "SessionStart",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    ...(harness === "codex" ? [] : ["PostToolUseFailure"]),
    "SessionEnd",
  ];
  for (const phase of phases) {
    // Every managed hook gets an explicit timeout above the AI classifier's (at most 20 s) plus a
    // margin: a review can wait for the classifier, and Copilot's default of 30 s fails open.
    // Codex limits SessionEnd to 1 to 3 seconds and warns about anything longer.
    const timeout = harness === "codex" && phase === "SessionEnd" ? 3 : HOOK_TIMEOUT_SECONDS;
    if (harness === "copilot") {
      const event = phase[0]?.toLowerCase() + phase.slice(1);
      hooks[event] = [
        {
          type: "command",
          ...(phase === "PreToolUse" || phase.startsWith("PostToolUse") ? { matcher } : {}),
          exec: process.execPath,
          args: [cliPath, "hook", harness, phase, managedHookFlag],
          timeoutSec: timeout,
        },
      ];
    } else
      hooks[phase] = [
        {
          ...(phase === "PreToolUse"
            ? { matcher: preMatcher }
            : phase.startsWith("PostToolUse")
              ? { matcher }
              : {}),
          hooks: [
            {
              type: "command",
              command: `"${process.execPath}" "${cliPath}" hook ${harness} ${phase} ${managedHookFlag}`,
              timeout,
            },
          ],
        },
      ];
  }
  return harness === "copilot" ? { version: 1, hooks } : { hooks };
}
