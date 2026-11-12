import { isAbsolute } from "node:path";
import type { Request } from "./types.js";
export const managedHookFlag = "--agent-corpus-policy-manager-hook";
export function hookConfig(harness: Request["harness"], cliPath: string): Record<string, unknown> {
  if (![cliPath, process.execPath].every((path) => isAbsolute(path) && !/["\r\n$`%]/.test(path)))
    throw new Error("Use a safe absolute path to the reviewed CLI installation");
  if (!["claude", "codex", "copilot"].includes(harness)) throw new Error("Unknown harness");
  const hooks: Record<string, unknown> = {};
  const matcher =
    "Bash|Read|Edit|Write|apply_patch|bash|powershell|view|read_file|write_file|edit|create|exec_command|shell";
  const phases = [
    "SessionStart",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    ...(harness === "codex" ? [] : ["PostToolUseFailure"]),
    "SessionEnd",
  ];
  for (const phase of phases) {
    // Codex limits SessionEnd to 1 to 3 seconds and warns about anything longer.
    const timeout = harness === "codex" && phase === "SessionEnd" ? 3 : 8;
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
          ...(phase === "PreToolUse" || phase.startsWith("PostToolUse") ? { matcher } : {}),
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
