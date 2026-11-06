# @agent-corpus/agent-scaffold

Create a skill or agent scaffold before adding instructions. Each artifact has one canonical body under `.agent-config/` and six native references for Claude Code, Copilot, and Codex. Consumer references live under `static-references/`.

```sh
agent-scaffold usage
agent-scaffold agent policy-manager "Evaluate session permission requests" /path/to/worktree
agent-scaffold skill create-agent "Create portable coding agents" /path/to/worktree
```

Fill only the returned canonical file. Harness settings and runtime permissions require separate, reviewed integration. Existing files are never replaced. A concurrent collision stops creation; already-created scaffold files remain visible for inspection. Exit codes: 0 success, 1 invalid input, collision, or filesystem failure. `usage --json` provides machine-readable help.
