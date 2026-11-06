import { isAbsolute } from "node:path";
import type { Request } from "./types.js";
export function hookConfig(harness: Request["harness"], cliPath: string): Record<string, unknown> {
  if (!isAbsolute(cliPath) || /["\r\n$`%]/.test(cliPath))
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
    if (harness === "copilot") {
      const event = phase[0]?.toLowerCase() + phase.slice(1);
      hooks[event] = [
        {
          type: "command",
          ...(phase === "PreToolUse" || phase.startsWith("PostToolUse") ? { matcher } : {}),
          exec: process.execPath,
          args: [cliPath, "hook", harness, phase],
          timeoutSec: 8,
        },
      ];
    } else
      hooks[phase] = [
        {
          ...(phase === "PreToolUse" || phase.startsWith("PostToolUse") ? { matcher } : {}),
          hooks: [
            {
              type: "command",
              command: `"${process.execPath}" "${cliPath}" hook ${harness} ${phase}`,
              timeout: 8,
            },
          ],
        },
      ];
  }
  return harness === "copilot" ? { version: 1, hooks } : { hooks };
}
