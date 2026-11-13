---
"@agent-corpus/policy-manager": minor
---

The permissive profile now approves writes to the system temp directory and deletions inside scratch or temp directories without asking, while policy state, repositories, and credential or protected paths stay guarded. The classification prompt reads as an instruction (`Needs classification (not an error)`), states the approval rule, and survives a retry with a different command description.
