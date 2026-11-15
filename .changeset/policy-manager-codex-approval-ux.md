---
"@agent-corpus/policy-manager": minor
---

Make approving a blocked request under Codex usable, and stop classifying harmless harness tools. The Codex deny reason now leads with "Waiting for your approval", puts the command on its own line, names the `--session` scope, and tells the agent to stop. `approve --last` approves the newest blocked request without a session id or hash, and setup installs a managed `pm` launcher so the command is `pm approve --last`. Shell redirect and `tee` writes get a session scope like patches. Under the permissive profile, harness tools that are not shell, file, patch or MCP tools are approved by default and listed in `review-classifications`; the profile's `toolsDeny` keeps chosen ones on the classification path. A variable holding a single-quoted literal is usable inside double quotes.
