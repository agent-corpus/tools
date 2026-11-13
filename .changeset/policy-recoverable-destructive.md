---
"@agent-corpus/policy-manager": minor
---

The permissive profile no longer prompts for deletions that can be undone or thrown away. This covers removing committed files or files the session itself created, and `git reset --hard`, `checkout --` or `restore` that discard nothing, all in a feature worktree. Other file deletions inside a feature worktree are approved only when the session classifier judges them recoverable. History, remote, cloud and publishing operations still go to a person.
