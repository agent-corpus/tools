---
"@agent-corpus/policy-manager": minor
---

Codex no longer reports "unsupported permissionDecision:allow" on every approved tool call: an approval now sends no decision, and Codex's own prompt is approved through `PermissionRequest`. A session can now edit another repository's linked feature worktree with `cd <worktree> && ...` and create worktrees under `.worktrees/` or `.claude/worktrees/` from any clone, while writes to a main checkout still go to a person.
