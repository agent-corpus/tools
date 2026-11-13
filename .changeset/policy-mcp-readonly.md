---
"@agent-corpus/policy-manager": minor
---

Profiles can list read-only MCP tools in `mcpReadOnly` (exact `mcp__<server>__<tool>` names, or a tool-name prefix ending in `*`), and those tools run without a prompt; unlisted MCP tools are left to the harness's own permission flow. `setup-hook-claude` and `setup-hook-codex` add `mcp__.*` to the `PreToolUse` matcher (Codex users re-trust the hook in `/hooks`); Copilot is not supported.
