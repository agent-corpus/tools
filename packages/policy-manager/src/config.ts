import { isAbsolute } from "node:path";
import type { Request } from "./types.js";
export const managedHookFlag = "--agent-corpus-policy-manager-hook";
/** Seconds each managed hook may run: above the service's review wait, which covers the classifier. */
export const HOOK_TIMEOUT_SECONDS = 45;
/** The hook argument that tells a Codex PreToolUse hook how long to wait for the user's approval. */
export const WAIT_FLAG = "--approval-wait";
/** How long a Codex PreToolUse hook waits for the user to approve a blocked request, by default. */
export const DEFAULT_APPROVAL_WAIT_SECONDS = 600;
/** The longest wait: a blocked request can be approved for 15 minutes after it was asked. */
export const MAX_APPROVAL_WAIT_SECONDS = 840;
export interface HookConfigOptions {
  /** Seconds a Codex PreToolUse hook waits for an approval; 0 denies at once as before. */
  approvalWaitSeconds?: number;
  /** The approve command the Codex status line names while the hook waits. */
  approveCommand?: string;
}
/** The Codex PreToolUse status line: Codex shows it while the hook runs, and nothing else. */
export function waitStatus(approveCommand: string): string {
  return `Policy check. If this keeps running, a request is waiting for you: run ${approveCommand} in your own terminal`;
}
export function hookConfig(
  harness: Request["harness"],
  cliPath: string,
  options: HookConfigOptions = {},
): Record<string, unknown> {
  const wait = options.approvalWaitSeconds ?? DEFAULT_APPROVAL_WAIT_SECONDS;
  if (!Number.isSafeInteger(wait) || wait < 0 || wait > MAX_APPROVAL_WAIT_SECONDS)
    throw new Error(`The approval wait must be 0 to ${MAX_APPROVAL_WAIT_SECONDS} seconds`);
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
    // A Codex PreToolUse that waits for the user runs for the review plus the wait. Codex documents
    // a 600 s default and no maximum for it; its source clamps only SessionEnd and Interrupt.
    const waits = harness === "codex" && phase === "PreToolUse" && wait > 0;
    const timeout =
      harness === "codex" && phase === "SessionEnd"
        ? 3
        : waits
          ? HOOK_TIMEOUT_SECONDS + wait
          : HOOK_TIMEOUT_SECONDS;
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
              command: `"${process.execPath}" "${cliPath}" hook ${harness} ${phase}${waits ? ` ${WAIT_FLAG} ${wait}` : ""} ${managedHookFlag}`,
              timeout,
              ...(waits
                ? {
                    statusMessage: waitStatus(
                      options.approveCommand ?? `node "${cliPath}" approve --last`,
                    ),
                  }
                : {}),
            },
          ],
        },
      ];
  }
  return harness === "copilot" ? { version: 1, hooks } : { hooks };
}
/** A wait in seconds as people say it: "10 minutes", "90 seconds". */
export function formatWait(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
