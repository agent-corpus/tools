/**
 * The owner's rule for what needs a person. The engine enforces the deterministic part; the
 * classifier is told this text so its answers agree with the engine.
 */
export const HUMAN_ONLY_FOR =
  "unrecoverable loss (deleting unmerged work, data with no backup), credential or secret retrieval, protected configuration or paths, and the profile's humanPatterns";

/** The one rule every harness's classifier is given, and the one the engine enforces. */
export const HUMAN_REVIEW_PRINCIPLE = `A person is needed only for ${HUMAN_ONLY_FOR}. Everything recoverable is approvable by AI, including outward-facing writes such as a GitHub issue or PR comment: answer recoverable true with its category, not unknown. Recoverable or disposable effects are automatic, including destructive-but-safe ones such as deleting, inside a feature worktree, tracked content Git can restore or a file this session itself created.`;
