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
  fallbackReason?: "unavailable" | "invalid-result" | "limit";
  ai?: Classification;
}

export interface OutcomeReport {
  requestHash: string;
  event: "human-response" | "execution-result";
  response?: "approved" | "denied";
  status?: "completed" | "succeeded" | "failed" | "cancelled" | "unknown";
  exitCode?: number;
  durationMs?: number;
}
