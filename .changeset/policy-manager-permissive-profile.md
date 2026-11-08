---
"@agent-corpus/policy-manager": minor
---

Add an optional policy profile (`policy-manager profile install <file>`) with a `permissive` mode that approves compound shell commands and everything except destructive, credential and protected-path effects. Remote and local branch deletion is automatic only when the branch is already merged into origin's default branch, including squash merges. Human-review messages no longer imply an AI classification that was not performed.
