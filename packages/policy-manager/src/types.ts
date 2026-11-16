export const CATEGORIES = [
  "code-read",
  "worktree-write",
  /** A recoverable write outside any repository, such as the system temp directory. */
  "temp-write",
  "cloud-read",
  "git-read",
  "impactful-write",
  "destructive",
  "sensitive",
  "unknown",
] as const;
export type Category = (typeof CATEGORIES)[number];
export interface Request {
  sessionId: string;
  harness: "claude" | "codex" | "copilot";
  cwd: string;
  tool: string;
  input: Record<string, unknown>;
}
export interface Classification {
  category: Category;
  confidence: number;
  requestHash: string;
  /** Whether the action can be undone (merged work, tracked files, anything a backup restores). */
  recoverable?: boolean;
  /** Short free-text reason from the classifier; capped and redacted before it is logged. */
  rationale?: string;
}
/** Where an ambiguous request stands in the AI classification flow. */
export type ClassificationStage = "requested" | "approved" | "denied" | "fallback";
export interface Decision {
  /**
   * `deny` is a decision the model sees and works around; `human` asks the person; `native` makes
   * no decision and leaves the request to the harness's own permission flow.
   */
  decision: "approve" | "human" | "deny" | "native";
  category: Category;
  reason: string;
  requestHash: string;
  cache: "none" | "session";
  cached: boolean;
  needsClassification?: boolean;
  /** `ambiguous`: the deterministic engine could not decide and nothing in code forbids it. */
  tier?: "ambiguous";
  classification?: ClassificationStage;
  /** Why a human was asked after classification could not decide. */
  fallbackReason?:
    | "unavailable"
    | "invalid-result"
    | "limit"
    | "disabled"
    | "too-long"
    | "missing"
    | "not-logged-in"
    | "exit"
    | "timeout"
    | "bad-json"
    | "schema";
  /** A hard human item: never classified, and no classification approves it. The rule it hit. */
  hard?: string;
  /** What the classifier said when it did not approve, shown to the person who is asked. */
  classifierNote?: string;
  /** Approved by the user's own harness permission rule: the rule, as written. */
  userAllowRule?: string;
  /** No decision because the user's own deny or ask rule matched: the rule, as written. */
  userRule?: string;
  ai?: Classification;
  /** A human decision the user may approve for the rest of the session (`approve --session`). */
  sessionGrantable?: boolean;
  /** What `approve --session` would cover, in words the user can check. */
  sessionScopeLabel?: string;
  /** A harness tool approved by default (not a shell, file, patch or MCP tool), by name. */
  defaultTool?: string;
  /** Listed credential helpers this request runs, as `<path>#<shape index>`. */
  credentialHelpers?: string[];
  /** The agent tried to approve a request itself: no approval instruction is offered for it. */
  userOnly?: boolean;
}

export interface OutcomeReport {
  requestHash: string;
  event: "human-response" | "execution-result";
  response?: "approved" | "denied";
  status?: "completed" | "succeeded" | "failed" | "cancelled" | "unknown";
  exitCode?: number;
  durationMs?: number;
}
