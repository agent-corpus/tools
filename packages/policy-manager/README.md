# @agent-corpus/policy-manager

A coding-agent-independent permission evaluator. It starts a private background service for each session, verifies ordinary code operations and cloud inspection commands, and records requests and decisions in a temporary audit log. No runtime dependencies or model API calls.

This is a conservative initial implementation. It grants only decisions supported by the deterministic catalog. A same-session AI classifier can explain ambiguous requests and recommend a structured replacement. Confidence alone never authorizes an opaque command.

## Usage

Build from an inspected worktree with `npm install` and `npm run build`. Install the reviewed package outside agent-writable worktrees before using it as an approval authority. The initial package is not yet published.

```sh
policy-manager usage --json
policy-manager config codex /absolute/reviewed/install/dist/cli.js
policy-manager config claude /absolute/reviewed/install/dist/cli.js
policy-manager config copilot /absolute/reviewed/install/dist/cli.js
```

`config` prints configuration. It does not change permissions or install hooks. Merge its output into the native settings without replacing existing hooks or permission rules:

| CLI         | Destination                                                                   | Activation                                                          |
| ----------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Claude Code | `~/.claude/settings.json` or repository `.claude/settings.json`               | Review configuration, then start a new session.                     |
| Codex       | `~/.codex/hooks.json` or repository `.codex/hooks.json`                       | Review and trust the exact hooks with `/hooks`.                     |
| Copilot     | `~/.copilot/hooks/policy-manager.json` or `.github/hooks/policy-manager.json` | Start a new session. Sandbox escape still needs human confirmation. |

Use the generated absolute installed path. Do not point approval hooks at a mutable worktree or an unpinned `npx` download. Keep native sandboxes and interactive approval modes enabled. Existing host grants and other hooks can authorize actions independently; this service does not revoke them.

The `SessionStart` hook starts one deterministic service and injects instructions to create a read-only policy-manager agent. Creation of the AI agent is a model action, not a native hook guarantee. Resident-agent availability varies by harness. This release has not established automatic resident-agent parity across the three CLIs. The fallback can run in the parent session when resident agents are unavailable.

## Request protocol

Pass one JSON object on standard input:

```json
{
  "sessionId": "session-example",
  "harness": "codex",
  "cwd": "/absolute/worktree",
  "tool": "Bash",
  "input": { "command": "az resource list" }
}
```

Run `policy-manager review codex session-example`. The response includes `decision` (`approve` or `human`), `category`, `reason`, `requestHash`, `cache`, and `cached`. The library exports the same evaluator.

The session's policy-manager agent returns the following object for an ambiguous request. The working agent submits it through `policy-manager classify codex session-example`:

```json
{ "requestHash": "<exact hash from review>", "category": "unknown", "confidence": 0.4 }
```

Categories are `code-read`, `worktree-write`, `cloud-read`, `git-read`, `impactful-write`, `destructive`, `sensitive`, and `unknown`. The threshold is 0.99 plus deterministic verification and category agreement. Unknown commands stay human decisions. No classifier starts a second harness or calls an external model API.

## Policy

- Ordinary file reads must resolve inside a Git repository.
- Ordinary file writes must resolve inside a linked worktree on a feature branch.
- Main clones, protected branches, credentials, Git metadata, policy files, and hook settings require human approval.
- Structured patches check all add, update, and move paths. Deletions require human approval.
- Cloud reads use an exact operation catalog and permitted options. Unknown verbs, endpoint overrides, secret retrieval, and cloud writes require human approval.
- A small Git inspection subset, `git fetch origin` with a verified network transport, and constrained feature worktree creation under `.worktrees/` are automatic. Branch deletion reports upstream and reachability evidence, but always requires a human. Fetched remote references can be stale.
- Shell expansions, pipelines, interpreters, package scripts, and unknown effects require human review. A worktree does not establish their safety.

These are approval recommendations, not a sandbox. Trusted local executables and their configuration remain part of the host's trust boundary. Hooks cannot observe every hosted tool or prevent arbitrary same-user processes from changing files. Recheck path evidence on every request; filesystem races still require host enforcement.

## Service, cache, and logs

The service uses a Unix socket on macOS/Linux and a named pipe on Windows. A random session token authenticates local requests. Files use owner-only modes on Unix. On Windows, the operating system's temporary-directory ACL is the access boundary; Unix modes do not establish Windows ACL isolation. Other processes running as the same user are outside this boundary.

The cache belongs to the service process and is scoped to harness plus session ID. It holds at most 512 cloud-inspection decisions, expires entries after one minute, and evaluates policy before lookup. Filesystem and branch evidence is never cached. `SessionEnd` or `policy-manager stop <harness> <session-id>` stops the service. An idle service stops after 30 minutes. Requests restart it when necessary; crash-created stale sockets require inspection rather than unsafe automatic deletion.

`SessionStart` reports the private temporary directory containing `audit.jsonl`. Each request and decision is recorded before an approval is returned. The log stores request hashes and safe operation metadata, not paths, argument values, source text, credentials, or model explanations. Compare request hashes against the original request in the harness transcript during an investigation. Logs remain after normal shutdown and can disappear during operating-system cleanup. Copy them before cleanup when needed.

Logging failure, malformed requests, service failure, and unknown semantics never produce an automatic approval. Permission hooks fall through to native human handling. Pre-tool failures exit 2. Host timeout behavior differs: Copilot command-hook timeouts fall through to its normal permission flow. Codex does not support `ask` in `PreToolUse`, so human recommendations add context and leave native permission handling unchanged.

## Validation and support

Tests exercise real service processes and native-shaped hook payloads for all three CLIs. These protocol tests are separate from authenticated live model sessions. CLI versions inspected during development: Claude Code 2.1.316, Codex CLI 0.166.0, Copilot CLI 1.0.104. Full live-session approval, resident-agent startup, and desktop validation remain rollout work. Do not describe generated hook configurations as an installed policy.

Verified documentation, November 5, 2026:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference)

Exit codes: 0 means a protocol response was returned; inspect `decision` before acting. 1 means invalid input or service failure. Pre-tool hook failures use 2. Diagnostics use stderr and contain no raw request data.
