import type { Decision, Request } from "./types.js";
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
  if (harness === "codex")
    return {
      hookSpecificOutput: {
        hookEventName: phase,
        additionalContext: `${decision.reason}. Request ${decision.requestHash}. The policy manager grants no approval. Classify ambiguous requests with the session policy-manager agent. Preserve the native human approval flow.`,
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
