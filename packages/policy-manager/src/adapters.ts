import { hash } from "./policy.js";
import type { Decision, OutcomeReport, Request } from "./types.js";
export function normalize(harness: Request["harness"], payload: Record<string, unknown>): Request {
  let input: unknown = payload.tool_input ?? payload.toolInput ?? payload.toolArgs ?? {};
  if (typeof input === "string") input = JSON.parse(input);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid tool input");
  const args = input as Record<string, unknown>;
  const cwd = args.workdir ?? args.cwd ?? payload.cwd;
  return {
    sessionId: String(payload.session_id ?? payload.sessionId ?? ""),
    harness,
    cwd: typeof cwd === "string" ? cwd : "",
    tool: String(payload.tool_name ?? payload.toolName ?? ""),
    input: args,
  };
}
export function hookResponse(
  harness: Request["harness"],
  phase: string,
  decision: Decision,
): Record<string, unknown> {
  if (harness === "copilot") {
    if (phase === "PermissionRequest")
      return decision.decision === "approve" ? { behavior: "allow" } : {};
    return decision.decision === "approve"
      ? { permissionDecision: "allow" }
      : { permissionDecision: "ask", permissionDecisionReason: decision.reason };
  }
  if (phase === "PermissionRequest")
    return decision.decision === "approve"
      ? { hookSpecificOutput: { hookEventName: phase, decision: { behavior: "allow" } } }
      : {};
  if (decision.decision === "approve")
    return { hookSpecificOutput: { hookEventName: phase, permissionDecision: "allow" } };
  // Codex parses permissionDecision "ask" but does not support it: it marks the hook failed and
  // runs the tool anyway (https://developers.openai.com/codex/hooks). Only "deny" stops a command,
  // so a decision that needs a human is a deny that tells the model to ask the user. Codex's own
  // approval prompt (PermissionRequest, above) still handles the requests it would ask about.
  if (harness === "codex")
    return {
      hookSpecificOutput: {
        hookEventName: phase,
        permissionDecision: "deny",
        permissionDecisionReason: `Policy manager: ${decision.reason}. This needs the user's approval and was not run. Ask the user to approve it or run it themselves. Request ${decision.requestHash}.`,
      },
    };
  return {
    hookSpecificOutput: {
      hookEventName: phase,
      permissionDecision: "ask",
      permissionDecisionReason: decision.reason,
    },
  };
}

export function executionReport(
  request: Request,
  phase: string,
  payload: Record<string, unknown>,
): OutcomeReport {
  const response =
    payload.tool_response ?? payload.toolResponse ?? payload.tool_result ?? payload.toolResult;
  const result =
    response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const code = result.exit_code ?? result.exitCode;
  const exitCode =
    typeof code === "number" && Number.isSafeInteger(code) && Math.abs(code) <= 2147483647
      ? code
      : undefined;
  // Codex sends a Bash result as the output text alone: no exit code and no duration, even for a
  // command that exited non-zero. That is not "completed"; the outcome is unknown. Claude and
  // Copilot keep their existing behaviour.
  const unknown = exitCode === undefined && request.harness === "codex";
  const duration = payload.duration_ms ?? payload.durationMs;
  return {
    requestHash: hash(request),
    event: "execution-result",
    status:
      phase === "PostToolUseFailure"
        ? payload.is_interrupt === true
          ? "cancelled"
          : "failed"
        : exitCode === undefined
          ? unknown
            ? "unknown"
            : "completed"
          : exitCode === 0
            ? "succeeded"
            : "failed",
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0
      ? { durationMs: duration }
      : {}),
  };
}
