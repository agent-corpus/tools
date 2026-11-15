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
   * `deny` is a decision the model sees and works around; `human` asks the person (only for the
   * profile's `alwaysAsk` hard list once a session reviews it); `native` makes no decision and
   * leaves the request to the harness's own permission flow.
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
  /** A `native` decision that would have asked a person: the reason it would have asked. */
  deferred?: string;
  /** A `human` decision on the profile's `alwaysAsk` hard list: the rule id or category it matched. */
  alwaysAsk?: string;
}

export interface OutcomeReport {
  requestHash: string;
  event: "human-response" | "execution-result";
  response?: "approved" | "denied";
  status?: "completed" | "succeeded" | "failed" | "cancelled" | "unknown";
  exitCode?: number;
  durationMs?: number;
}

/**
 * Rules that still ask a person although the policy manager otherwise defers to the harness's
 * native permission flow. A profile's `alwaysAsk` lists these ids or decision categories.
 */
export const ALWAYS_ASK_RULES = [
  /** `git push --force`/`--mirror`, and `+` refspecs: they overwrite remote history. */
  "force-push",
  /** Deleting a local or remote branch whose commits are not verified merged. */
  "delete-unmerged-branch",
  /** `git worktree remove --force`/`prune`: discards a worktree's uncommitted and untracked work. */
  "remove-worktree-force",
  /** `git clean`: deletes untracked files. */
  "git-clean",
  /** Writes to harness permission and hook settings. */
  "harness-settings",
  /** Writes to the policy profile itself. */
  "policy-profile",
  /** A command matching the profile's `humanPatterns`. */
  "human-patterns",
  /** Credential or secret retrieval, and reads of credential paths. Off by default. */
  "credential-read",
  /** Cloud changes and deletions outside the verified inspection catalog. Off by default. */
  "cloud-write",
  /**
   * Any other destructive command: `rm -rf` outside a feature worktree or temp directory,
   * `git reset --hard`, `git checkout -- .`, `git stash drop`, deletions, publishing. Off by default.
   */
  "destructive-other",
] as const;
export type AlwaysAskRule = (typeof ALWAYS_ASK_RULES)[number];

/** The `alwaysAsk` a profile gets when it sets none. */
export const DEFAULT_ALWAYS_ASK: readonly AlwaysAskRule[] = [
  "force-push",
  "delete-unmerged-branch",
  "remove-worktree-force",
  "git-clean",
  "harness-settings",
  "policy-profile",
  "human-patterns",
];
