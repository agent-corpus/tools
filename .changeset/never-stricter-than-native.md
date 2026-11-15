---
"@agent-corpus/policy-manager": minor
---

Never stricter than the harness: a decision that needs a person is now left to the harness's native permission flow (no `PreToolUse` or `PermissionRequest` decision, and no Codex output), so the user's own allow rules and the native "don't ask again" prompt apply again. Only the profile's new `alwaysAsk` hard list still asks (Claude Code and Copilot `ask`, Codex deny with the `approve` command). Its default rule ids are `force-push`, `delete-unmerged-branch`, `remove-worktree-force`, `git-clean`, `harness-settings` and `policy-profile`; entries may also be decision categories. A classification fallback defers the same way. Deferrals are audited as decision `native` with the reason in `deferred`, and `replay` reports how many escalations defer and which still ask.
