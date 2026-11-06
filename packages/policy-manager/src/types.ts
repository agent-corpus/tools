export type Category =
  | "code-read"
  | "worktree-write"
  | "cloud-read"
  | "git-read"
  | "impactful-write"
  | "destructive"
  | "sensitive"
  | "unknown";
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
}
export interface Decision {
  decision: "approve" | "human";
  category: Category;
  reason: string;
  requestHash: string;
  cache: "none" | "session";
  cached: boolean;
  needsClassification?: boolean;
  ai?: Classification;
}

export interface OutcomeReport {
  requestHash: string;
  event: "human-response" | "execution-result";
  response?: "approved" | "denied";
  status?: "completed" | "succeeded" | "failed" | "cancelled";
  exitCode?: number;
  durationMs?: number;
}
