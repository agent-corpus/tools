import { requestHash } from "./policy.js";
import { HUMAN_REVIEW_PRINCIPLE } from "./principle.js";
import { CATEGORIES, type Decision, type OutcomeReport, type Request } from "./types.js";
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
/**
 * The exact command the model is told to run to record a classification. A here-string, not a
 * pipe: `printf ... | node ...` is "piping into an interpreter" and is itself escalated, so the
 * round trip could never finish. A test evaluates this exact string and requires `approve`.
 */
export function classifyCommand(
  harness: Request["harness"],
  context?: HookContext,
  json = "<json>",
): string {
  // A Windows path (`D:\\a\\cli.js`) is written with forward slashes: Node accepts them, and a
  // backslash inside double quotes is a shell escape the policy cannot judge, which would
  // escalate the command that finishes the round trip.
  const cliPath =
    context && /^[A-Za-z]:\\/.test(context.cliPath)
      ? context.cliPath.replace(/\\/g, "/")
      : context?.cliPath;
  const safe =
    context &&
    cliPath &&
    /^[^"$`\\\n']+$/.test(cliPath) &&
    /^[A-Za-z0-9_.-]+$/.test(context.sessionId);
  return safe
    ? `node "${cliPath}" classify ${harness} ${context.sessionId} <<< '${json}'`
    : `policy-manager classify ${harness} <session-id> <<< '${json}'`;
}
/**
 * Whether `command` is exactly this session's record command from `classifyCommand`, answer
 * included: one single-quoted literal JSON object, nothing before or after it. Inside single
 * quotes the shell expands nothing, so the answer cannot run anything.
 */
export function isClassifyRecord(
  command: string,
  harness: Request["harness"],
  context: HookContext,
): boolean {
  const template = classifyCommand(harness, context, "");
  if (!template.startsWith('node "')) return false;
  const head = template.slice(0, -1);
  if (command.length > head.length + 4096 || !command.startsWith(head) || !command.endsWith("'"))
    return false;
  const json = command.slice(head.length, -1);
  if (/['\0\r\n]/.test(json)) return false;
  try {
    const value: unknown = JSON.parse(json);
    return !!value && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|]+)`;
const CLI = String.raw`(?:"[^"]*cli\.js"|'[^']*cli\.js'|[^\s"';&|]*cli\.js)`;
const NODE = String.raw`(?:"(?:[^"]*[/\\])?node(?:\.exe)?"|'(?:[^']*[/\\])?node(?:\.exe)?'|(?:[^\s"';&|]*[/\\])?node(?:\.exe)?)`;
/** Assignments, wrappers and keywords that can stand before the command in a segment. */
const LEAD = String.raw`(?:[A-Za-z_]\w*=${WORD}?\s+|(?:then|do|else|elif|if|while|until|!)\s+|(?:env|command|builtin|exec|time|timeout|nohup|nice|ionice|xargs|stdbuf|sudo|doas)(?:\s+${WORD}){0,6}?\s+)*`;
/**
 * A command segment that runs a policy-manager CLI's `classify`, for any session or CLI: `node`
 * with a `cli.js`, or `policy-manager` (also through `npx`), at the start of the script or after
 * an operator, behind any assignments, wrappers (`env`, `exec`, `xargs`...) or keywords. Text
 * that only mentions such a command (a `grep` pattern, a commit message) does not match, and
 * neither does a script nested in quotes (`sh -c '...'`), which gets the normal decision.
 */
const CLASSIFY_INVOCATION = new RegExp(
  String.raw`(?:^|[;&|({` +
    "`" +
    String.raw`\n]|\$\()\s*${LEAD}(?:${NODE}\s+(?:-${WORD}\s+)*${CLI}|(?:npx\s+(?:-\S+\s+)*)?(?:@agent-corpus\/)?policy-manager(?:@\S+)?)\s+["']?classify\b`,
);
/** A command that runs a policy-manager classification record, for any session or CLI. */
export function looksLikeClassifyRecord(command: string): boolean {
  return CLASSIFY_INVOCATION.test(command);
}
/**
 * A command that runs, or names, a policy-manager `approve`, anywhere in the script and at any
 * nesting (`sh -c '...'`, a here-document). Unlike a classification record, the agent never runs
 * this: only the user approves, from their own terminal.
 */
const APPROVE_PROGRAM = /^(?:.*cli\.js|(?:@agent-corpus\/)?policy-manager(?:@.*)?)$/;
// A token scan rather than one regular expression over the command, so its cost stays linear.
export function looksLikeApproveGrant(command: string): boolean {
  const tokens = command.split(/[\s"'`;&|()]+/);
  return tokens.some((token, i) => tokens[i + 1] === "approve" && APPROVE_PROGRAM.test(token));
}
/** The command the user runs in their own terminal to approve a human decision. */
export function approveCommand(
  harness: Request["harness"],
  requestHash: string,
  context?: HookContext,
): string {
  const cliPath =
    context && /^[A-Za-z]:\\/.test(context.cliPath)
      ? context.cliPath.replace(/\\/g, "/")
      : context?.cliPath;
  return cliPath && context
    ? `node "${cliPath}" approve ${harness} ${context.sessionId} ${requestHash}`
    : `policy-manager approve ${harness} <session-id> ${requestHash}`;
}
function approveInstruction(
  harness: Request["harness"],
  decision: Decision,
  context?: HookContext,
): string {
  const command = approveCommand(harness, decision.requestHash, context);
  const session = decision.sessionGrantable
    ? " Adding --session also allows later requests in this session that hit the same rule for the same scope."
    : "";
  return `Approving it in chat does not unblock it. To allow it once, the user runs in their own terminal: ${command} — then retry the same request unchanged.${session} Do not run that command yourself.`;
}
/** What a blocked ambiguous request tells the model to do. Never ask for human approval here. */
function classifyInstruction(
  harness: Request["harness"],
  decision: Decision,
  context?: HookContext,
): string {
  const command = classifyCommand(harness, context);
  return `Needs classification (not an error): not run yet. Ask the session's policy-manager agent whether this exact command is recoverable and non-sensitive, record its answer, then retry the same command unchanged. Rule: ${HUMAN_REVIEW_PRINCIPLE} Request ${decision.requestHash}: ${decision.reason}. Answer shape: {"requestHash":"${decision.requestHash}","category":"${CATEGORIES.join("|")}","confidence":0.0-1.0,"recoverable":true|false,"rationale":"one short sentence without quotes"}. Record it by replacing <json> in this command, with no single quotes in the answer: ${command} If no classification is available, retry once and the user will be asked.`;
}
export function hookResponse(
  harness: Request["harness"],
  phase: string,
  decision: Decision,
  context?: HookContext,
): Record<string, unknown> {
  if (decision.decision === "native") return {};
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
  // Codex rejects PreToolUse `permissionDecision: "allow"` without `updatedInput` ("unsupported
  // permissionDecision:allow") and marks the hook failed. An approval there is no decision at all;
  // if Codex would then prompt, its PermissionRequest hook (above) returns the allow.
  if (decision.decision === "approve")
    return harness === "codex"
      ? {}
      : { hookSpecificOutput: { hookEventName: phase, permissionDecision: "allow" } };
  // Codex parses permissionDecision "ask" but does not support it: it marks the hook failed and
  // runs the tool anyway (https://developers.openai.com/codex/hooks). Only "deny" stops a command,
  // so a decision that needs a human is a deny. Approving it in chat does not change the decision;
  // the user approves it from their own terminal (`approve`, once or for the session), or an
  // ambiguous request (needsClassification) is classified, and a retry then sees the approval.
  // Codex's own approval prompt (PermissionRequest, above) still handles the requests it asks about.
  if (harness === "codex") {
    const next =
      decision.needsClassification === true && decision.classification !== "fallback"
        ? "Classify it with the session policy-manager agent and retry. If it is not classified as approved, the retry is blocked with the command the user runs to approve it."
        : approveInstruction(harness, decision, context);
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

/** The exact stdout of a PreToolUse or PermissionRequest hook. Codex gets no output for no decision. */
export function hookOutput(
  harness: Request["harness"],
  phase: string,
  decision: Decision,
  context?: HookContext,
): string {
  const response = hookResponse(harness, phase, decision, context);
  return harness === "codex" && Object.keys(response).length === 0 ? "" : JSON.stringify(response);
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
    requestHash: requestHash(request),
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
