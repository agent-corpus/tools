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
export interface HookContext {
  cliPath: string;
  sessionId: string;
}
/** What a blocked ambiguous request tells the model to do. Never ask for human approval here. */
function classifyInstruction(
  harness: Request["harness"],
  decision: Decision,
  context?: HookContext,
): string {
  const command = context
    ? `printf '%s' '<json>' | node "${context.cliPath}" classify ${harness} ${context.sessionId}`
    : "policy-manager classify";
  return `Not run yet: this request needs classification before it can run (request ${decision.requestHash}; ${decision.reason}). Ask the session's policy-manager agent whether the exact command is recoverable and non-sensitive. It answers with {"requestHash":"${decision.requestHash}","category":"code-read|worktree-write|cloud-read|git-read|impactful-write|destructive|sensitive|unknown","confidence":0.0-1.0,"recoverable":true|false,"rationale":"one short sentence without quotes"}. Record that answer with: ${command} and then retry the same command unchanged. If you cannot get a classification, retry once and the user will be asked.`;
}
export function hookResponse(
  harness: Request["harness"],
  phase: string,
  decision: Decision,
  context?: HookContext,
): Record<string, unknown> {
  if (decision.decision === "deny") {
    const reason =
      decision.classification === "requested"
        ? classifyInstruction(harness, decision, context)
        : decision.reason;
    if (phase === "PermissionRequest")
      return harness === "copilot"
        ? {}
        : {
            hookSpecificOutput: {
              hookEventName: phase,
              decision: { behavior: "deny", message: reason },
            },
          };
    return harness === "copilot"
      ? { permissionDecision: "deny", permissionDecisionReason: reason }
      : {
          hookSpecificOutput: {
            hookEventName: phase,
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
  }
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
  // so a decision that needs a human is a deny. Approving it in chat does not change the decision,
  // so the reason says so; the one in-session way through is classifying an ambiguous cloud
  // request (needsClassification), which a retry then sees as approved. Codex's own approval prompt
  // (PermissionRequest, above) still handles the requests it would ask about.
  if (harness === "codex") {
    const next =
      decision.needsClassification === true && decision.classification !== "fallback"
        ? "Classify it with the session policy-manager agent and retry. If it is not classified as approved, ask the user to run it themselves or to change the policy profile."
        : "Approving it in this session does not unblock it: ask the user to run it themselves or to change the policy profile.";
    return {
      hookSpecificOutput: {
        hookEventName: phase,
        permissionDecision: "deny",
        permissionDecisionReason: `Policy manager: ${decision.reason}. This needs a human decision and was not run. ${next} Request ${decision.requestHash}.`,
      },
    };
  }
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
