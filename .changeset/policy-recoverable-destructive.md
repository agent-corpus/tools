---
---

policy-manager: the permissive profile approves deletions and resets that Git can undo (`rm` and `git rm -f` of tracked, unmodified files; `git reset --hard`, `git checkout --` and `git restore` that discard nothing) in linked feature worktrees, with evidence read at decision time. Other destructive requests go to the session classifier: approved when judged recoverable, otherwise a person decides. `HUMAN_REVIEW_PRINCIPLE` states the rule in every classification hint.
