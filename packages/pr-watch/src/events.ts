/** Every event type `pr-watch` can emit, with guidance an agent can act on. */
export interface EventSpec {
  type: string;
  description: string;
  /** Agent-agnostic suggestion for a follow-on action. */
  suggestedAction: string;
  /** Shape of the `data` field, for documentation. */
  data: Record<string, string>;
}

export const EVENT_CATALOG = [
  {
    type: "base_moved",
    description: "The base branch (e.g. main) advanced since the last observation.",
    suggestedAction:
      "Fetch the base branch. If `stale` also fired, merge or rebase the base into the PR branch, run tests, push.",
    data: { baseRef: "base branch name", from: "previous base sha", to: "new base sha" },
  },
  {
    type: "stale",
    description:
      "The PR branch is behind its base by at least --stale-after commits (default 1). Fires on transition, and at startup if already stale (initial: true).",
    suggestedAction:
      "Update the PR branch from the base (rebase or merge per repo convention), resolve conflicts, run tests, push.",
    data: { behindBy: "commits behind base", threshold: "configured --stale-after" },
  },
  {
    type: "conflicts",
    description: "The PR has merge conflicts with its base. Fires on transition and at startup.",
    suggestedAction: "Update the branch from the base and resolve the conflicts, then push.",
    data: { mergeableState: "GitHub mergeable_state, e.g. dirty" },
  },
  {
    type: "conflicts_resolved",
    description: "A previously conflicting PR can now merge cleanly.",
    suggestedAction: "No action needed; continue watching or proceed to merge.",
    data: { mergeableState: "GitHub mergeable_state" },
  },
  {
    type: "review_approved",
    description: "A reviewer approved the PR.",
    suggestedAction: "If all required approvals and checks are in, the PR may be ready to merge.",
    data: { id: "review id", user: "login", body: "review text", url: "permalink" },
  },
  {
    type: "review_changes_requested",
    description: "A reviewer requested changes.",
    suggestedAction:
      "Read the review and its inline comments, make the changes, push, and reply to or resolve each thread.",
    data: { id: "review id", user: "login", body: "review text", url: "permalink" },
  },
  {
    type: "review_commented",
    description: "A reviewer submitted a review with state COMMENTED (no verdict).",
    suggestedAction: "Read the review; address any questions or requests it contains.",
    data: { id: "review id", user: "login", body: "review text", url: "permalink" },
  },
  {
    type: "review_comment",
    description: "A new inline code-review comment was posted on the diff.",
    suggestedAction:
      "Read the comment at path:line, make the requested change or reply with reasoning.",
    data: {
      id: "comment id",
      user: "login",
      path: "file path",
      line: "line number or null",
      body: "comment text",
      url: "permalink",
      inReplyTo: "parent comment id or null",
    },
  },
  {
    type: "comment",
    description: "A new conversation comment was posted on the PR (not on the diff).",
    suggestedAction: "Read the comment; respond or act if it asks for something.",
    data: { id: "comment id", user: "login", body: "comment text", url: "permalink" },
  },
  {
    type: "checks_failed",
    description: "CI checks on the head commit are failing. Fires on transition and at startup.",
    suggestedAction: "Inspect the failing checks' logs, fix the cause, push.",
    data: { failing: "names of failing checks", headSha: "commit the checks ran on" },
  },
  {
    type: "checks_passed",
    description: "All CI checks on the head commit completed successfully.",
    suggestedAction: "Nothing to fix. If approved and not stale, the PR may be ready to merge.",
    data: { headSha: "commit the checks ran on" },
  },
  {
    type: "head_updated",
    description: "New commits were pushed to the PR branch (by anyone).",
    suggestedAction: "If you did not push them, pull the branch before making further changes.",
    data: { from: "previous head sha", to: "new head sha" },
  },
  {
    type: "ready_for_review",
    description: "The PR was moved out of draft.",
    suggestedAction: "Informational.",
    data: {},
  },
  {
    type: "pr_merged",
    description: "The PR was merged. Terminal: the watcher exits.",
    suggestedAction: "Clean up the local branch; stop monitoring.",
    data: { mergedBy: "login or null" },
  },
  {
    type: "pr_closed",
    description: "The PR was closed without merging. Terminal: the watcher exits.",
    suggestedAction: "Stop monitoring unless the user asks to reopen.",
    data: {},
  },
] as const satisfies readonly EventSpec[];

export type EventType = (typeof EVENT_CATALOG)[number]["type"];

export const EVENT_TYPES: readonly EventType[] = EVENT_CATALOG.map((e) => e.type);

export const TERMINAL_EVENTS: readonly EventType[] = ["pr_merged", "pr_closed"];

/** One line of NDJSON output. */
export interface PrEvent {
  type: EventType;
  /** Canonical PR reference, `owner/repo#number`. */
  pr: string;
  /** ISO timestamp of detection. */
  at: string;
  /** True when the condition already held when watching began. */
  initial?: true;
  data: Record<string, unknown>;
  /** Human/agent readable next step, from the catalog. */
  hint: string;
}

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export function hintFor(type: EventType): string {
  return EVENT_CATALOG.find((e) => e.type === type)?.suggestedAction ?? "";
}
