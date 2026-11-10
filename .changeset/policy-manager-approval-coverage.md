---
"@agent-corpus/policy-manager": minor
---

Permissive profile: judge protected names relative to the repository root so linked worktrees under `.claude/worktrees` are ordinary code, resolve `cd ~` and bare `cd`, approve read-only cloud verbs (`az`, `aws`, `gcloud` list/show/describe/get) outside the exact catalog, and allow a short list of non-executable local `git config` keys. Add `policy-manager replay <transcripts>` to measure the approval rate over recorded Bash commands without executing anything.
