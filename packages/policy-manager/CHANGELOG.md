# @agent-corpus/policy-manager

## 0.2.0

### Minor Changes

- [#15](https://github.com/agent-corpus/tools/pull/15) [`b6c7db0`](https://github.com/agent-corpus/tools/commit/b6c7db0e3d45b44169160ce8f5814b2130ae0d4a) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Permissive profile: judge protected names relative to the repository root so linked worktrees under `.claude/worktrees` are ordinary code, resolve `cd ~` and bare `cd`, approve read-only cloud verbs (`az`, `aws`, `gcloud` list/show/describe/get) outside the exact catalog, and allow a short list of non-executable local `git config` keys. Add `policy-manager replay <transcripts>` to measure the approval rate over recorded Bash commands without executing anything.

- [#14](https://github.com/agent-corpus/tools/pull/14) [`bdccaf8`](https://github.com/agent-corpus/tools/commit/bdccaf84deb30908c5531c0aef7149e627336a30) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Add an optional policy profile (`policy-manager profile install <file>`) with a `permissive` mode that approves compound shell commands and everything except destructive, credential and protected-path effects. Remote and local branch deletion is automatic only when the branch is already merged into origin's default branch, including squash merges. Human-review messages no longer imply an AI classification that was not performed.

### Patch Changes

- [#13](https://github.com/agent-corpus/tools/pull/13) [`bb20968`](https://github.com/agent-corpus/tools/commit/bb2096811b49a3ae21c56f36805b63120d018144) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Resolve Windows short-path aliases before checking repository boundaries, so valid reads and linked-worktree writes receive the same decisions as on macOS and Linux.

- `SessionEnd` no longer fails when no policy service is running for the session (for example `claude update`, or a session that never started). It exits successfully, creates no session directory, and still reports unsafe-directory and other real errors.
