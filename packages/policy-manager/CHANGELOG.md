# @agent-corpus/policy-manager

## 0.2.1

### Patch Changes

- Security: a quoted or escaped value in a leading assignment (`FOO="a b" rm -rf x`, `FOO=a\ b git push --force`) made the parser treat the whole `FOO=...` word as the program, so the real command after it was never checked and could be auto-approved. Leading assignments are now recognised from their plain `NAME=` prefix regardless of quotes or escapes in the value. Appended and indexed forms (`FOO+=x`, `FOO[0]=x`) and assignments with a quoted or escaped name, which the parser cannot represent, are rejected so a human reviews them, and `env` treats any `NAME…=value` word as an assignment before judging the program that follows. Present in 0.2.0 and earlier permissive-profile releases; upgrade to 0.2.1.

- [#19](https://github.com/agent-corpus/tools/pull/19) [`e3b73d3`](https://github.com/agent-corpus/tools/commit/e3b73d3147b31eaef31b845cc3384cf6c80264b3) Thanks [@charlesprakash](https://github.com/charlesprakash)! - The shell parser now accepts backslash escapes: `\.`, `\|` and `\ ` outside quotes, and `\"`, `\\`, `\$` inside double quotes. An escaped character is always literal, so an escaped `;`, `&&` or quote never splits a command or ends a string. A trailing backslash and a backslash-newline are still rejected. In replay over local transcripts this raises the permissive approval rate from 34.7% to 53.7%.

## 0.2.0

### Minor Changes

- [#15](https://github.com/agent-corpus/tools/pull/15) [`b6c7db0`](https://github.com/agent-corpus/tools/commit/b6c7db0e3d45b44169160ce8f5814b2130ae0d4a) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Permissive profile: judge protected names relative to the repository root so linked worktrees under `.claude/worktrees` are ordinary code, resolve `cd ~` and bare `cd`, approve read-only cloud verbs (`az`, `aws`, `gcloud` list/show/describe/get) outside the exact catalog, and allow a short list of non-executable local `git config` keys. Add `policy-manager replay <transcripts>` to measure the approval rate over recorded Bash commands without executing anything.

- [#14](https://github.com/agent-corpus/tools/pull/14) [`bdccaf8`](https://github.com/agent-corpus/tools/commit/bdccaf84deb30908c5531c0aef7149e627336a30) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Add an optional policy profile (`policy-manager profile install <file>`) with a `permissive` mode that approves compound shell commands and everything except destructive, credential and protected-path effects. Remote and local branch deletion is automatic only when the branch is already merged into origin's default branch, including squash merges. Human-review messages no longer imply an AI classification that was not performed.

### Patch Changes

- [#13](https://github.com/agent-corpus/tools/pull/13) [`bb20968`](https://github.com/agent-corpus/tools/commit/bb2096811b49a3ae21c56f36805b63120d018144) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Resolve Windows short-path aliases before checking repository boundaries, so valid reads and linked-worktree writes receive the same decisions as on macOS and Linux.

- `SessionEnd` no longer fails when no policy service is running for the session (for example `claude update`, or a session that never started). It exits successfully, creates no session directory, and still reports unsafe-directory and other real errors.
