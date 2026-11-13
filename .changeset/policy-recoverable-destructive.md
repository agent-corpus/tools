---
---

policy-manager: the permissive profile approves deletions and resets that Git can undo (`rm` and `git rm -f` of tracked, unmodified files; `git reset --hard`, `git checkout --` and `git restore` that discard nothing) in linked feature worktrees, with evidence read at decision time.
