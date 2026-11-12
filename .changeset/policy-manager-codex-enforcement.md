---
"@agent-corpus/policy-manager": minor
---

Codex: a decision that needs a human is now enforced. Codex parses `permissionDecision: "ask"` in `PreToolUse` but does not support it (it marks the hook failed and runs the tool anyway), so the adapter previously only added context and every such command ran. It now returns a `deny` whose reason tells the model to ask the user; approvals are still returned as `allow`, and Codex's own approval prompt (`PermissionRequest`) is left to Codex. Claude and Copilot output is unchanged and pinned by tests.

Codex `PostToolUse` sends a Bash result as plain output text with no exit code or duration, so the audit now records `unknown` instead of `completed` when the status cannot be derived; a structured `exit_code` is used when present. The generated Codex `SessionEnd` hook uses a 3-second timeout, the maximum Codex allows. The README and `setup-hook-codex` output now explain Codex hook trust: setup never grants it, the hash covers the command and the effective timeout, and any upgrade that changes the install path requires trusting the hooks again.
