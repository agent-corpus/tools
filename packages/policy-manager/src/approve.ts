import type { GrantPreview } from "./session.js";

/** What `approve` shows and asks the user in their own terminal. */

export type ApproveScope = "once" | "session";

/** The request as `approve` shows it: session, tool, command, rule and session scope. */
export function describeRequest(
  preview: Partial<GrantPreview>,
  session?: { harness: string; sessionId: string },
): string[] {
  return [
    ...(session ? [`Session:  ${session.harness} ${session.sessionId}`] : []),
    `Tool:     ${preview.tool}`,
    `Request:  ${preview.detail}`,
    `Rule:     ${preview.reason}`,
    ...(preview.sessionScope
      ? [`Scope:    ${preview.sessionScope} (if allowed for this session)`]
      : []),
  ];
}

/** The question; a session is offered only for a request that can be approved for the session. */
export function approveQuestion(sessionGrantable: boolean): string {
  return sessionGrantable
    ? "Allow just this once, or for this session? [o/s/N] "
    : "Allow just this once? [o/N] ";
}

/** The scope an answer chooses, or undefined for no (the default). */
export function parseAnswer(answer: string, sessionGrantable: boolean): ApproveScope | undefined {
  const text = answer.trim().toLowerCase();
  if (/^(?:o|once|y|yes)$/.test(text)) return "once";
  if (sessionGrantable && /^(?:s|session)$/.test(text)) return "session";
  return undefined;
}

export const ONCE_ONLY_NOTE =
  "This request can only be approved once: credential reads, possible unrecoverable loss and requests whose effect could not be determined are never approved for a session.";

/** What `approve` says after a grant: a waiting hook runs the request now; otherwise, retry. */
export function approvedMessage(scope: ApproveScope, waiting: boolean): string {
  const what = scope === "session" ? "Approved for this session." : "Approved once.";
  return waiting
    ? `${what} The waiting request runs now; the agent does not need to retry.`
    : `${what} Tell the agent to retry the request unchanged.`;
}
