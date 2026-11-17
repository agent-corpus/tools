---
"@agent-corpus/policy-manager": patch
---

A remembered yes for a protected-path write now covers later compound commands that write the same exact protected files in the same checkout, such as `echo "$(date)" >> .agent-config/test.md && cat .agent-config/test.md`. The engine reads the write targets itself and approves the grant only when everything else in the script is something it approves on its own, every target is a literal word, and no other hard rule applies. Claude Code's PostToolUse answer now remembers the scope shown when the person was asked.
