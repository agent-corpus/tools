# @agent-corpus/policy-manager

A coding-agent-independent permission evaluator. It starts a private background service for each session, verifies ordinary code operations and cloud inspection commands, and records requests and decisions in a temporary audit log. Uses the shared `@agent-corpus/audit-log` package and makes no model API calls.

This is a conservative initial implementation. It grants ordinary operations through deterministic checks. For additional cloud inspection operations, AI can confirm a bounded read-only candidate. A same-session AI classifier can categorize candidates and recommend structured replacements for opaque commands. Confidence alone never authorizes an opaque command.

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

## Install native hooks

Install the reviewed package outside Git checkouts, then run one setup command:

```sh
policy-manager setup-hook-claude --dry-run
policy-manager setup-hook-claude
policy-manager setup-hook-codex
policy-manager setup-hook-copilot
```

The canonical form is `policy-manager setup-hook <claude|codex|copilot>`. Each alias uses that same implementation. Setup connects native tool, permission, execution-report, startup, and shutdown hooks directly to the deterministic service. The working AI does not need to request policy-manager approval for recognized native hook events.

Setup merges only the managed hook definitions. Existing custom hooks, permissions, settings, allow rules, and deny rules remain. Repeated setup is idempotent. Package upgrades replace hooks carrying the managed marker; unmarked manual entries remain. Existing settings receive an owner-only backup, and updates use a temporary file with atomic replacement. Invalid JSON, unsupported schemas, symbolic links, concurrent setup, and detected concurrent edits fail without replacing the existing settings.

`--dry-run` prints the target path, proposed managed hooks, and next steps without writing files or printing existing settings. `--config-dir <directory>` selects a harness configuration root for portable profiles or testing. Defaults respect `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `COPILOT_HOME`, then use the standard user directories listed above. Setup refuses to activate an entrypoint inside a Git checkout, including an npm link into a checkout. Source builds can preview with `--dry-run`.

Start a new session after setup. Codex still requires explicit review and trust through `/hooks`; setup does not grant that trust. Existing sandbox controls and host permission rules continue to apply. Ambiguous requests retain the documented classification or human fallback; setup does not enable automatic AI fallback across unsupported native interfaces.

### Codex hook trust

Codex runs a non-managed hook only after you review and trust its exact definition, and setup never grants that trust. After `setup-hook-codex`, start Codex and open `/hooks`, review the five policy-manager hooks, and trust them. Until then Codex skips them and prints a warning at startup, so no policy decision is made.

Trust is recorded per hook in `config.toml` under `[hooks.state."<hooks.json path>:<event>:0:0"]` as `trusted_hash = "sha256:<hex>"`. The hash covers the event, the matcher, and the hook's command and timeout, so:

- Trust is tied to the command text only: Codex hashes the command line, not the script behind it. An upgrade that keeps the same CLI path (for example an in-place `npm install -g` upgrade) keeps trust while the code behind the hooks changes, so review a new version before upgrading in place. An upgrade that changes the command, such as installing into a per-version directory or a Node upgrade that changes `process.execPath` (it is part of the command), makes Codex mark all five hooks as changed and skip them until you trust them again. Re-running `setup-hook-codex` for the same installed version changes nothing and keeps trust.
- Codex hashes the effective timeout, which it limits to 1 to 3 seconds for `SessionEnd`. The generated `SessionEnd` timeout is 3 seconds, the same effective value as the earlier 8, so changing it did not by itself invalidate trust.
- `--dangerously-bypass-hook-trust` runs enabled hooks without persisted trust for one invocation. Use it only for automation that already vets the hook source.

Codex hook trust was checked against Codex CLI 0.167.1; see the [Codex hooks reference](https://developers.openai.com/codex/hooks) for the release behavior.

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

Categories are `code-read`, `worktree-write`, `cloud-read`, `git-read`, `impactful-write`, `destructive`, `sensitive`, and `unknown`. The threshold is 0.99 plus deterministic verification and category agreement. Explicitly listed metadata operations with permitted selectors can qualify through AI classification. Endpoint overrides and cloud writes cannot qualify. Unknown commands stay human decisions. No classifier starts a second harness or calls an external model API.

## Policy

- Ordinary file reads must resolve inside a Git repository.
- Ordinary file writes must resolve inside a linked worktree on a feature branch.
- Main clones, protected branches, credentials, Git metadata, policy files, and hook settings require human approval.
- Structured patches check all add, update, and move paths. Deletions require human approval.
- Cloud reads use exact inspection and metadata operation catalogs with permitted options. Credential-returning settings, connection strings, publishing credentials, and storage keys are sensitive before AI classification. Unknown verbs, endpoint overrides, secret retrieval, and cloud writes require human approval.
- A small Git inspection subset, `git fetch origin` with a verified network transport, and constrained feature worktree creation under `.worktrees/` are automatic. Branch deletion reports upstream and reachability evidence, but always requires a human. Fetched remote references can be stale.
- Shell expansions, pipelines, interpreters, package scripts, and unknown effects require human review. A worktree does not establish their safety.

These are approval recommendations, not a sandbox. Trusted local executables and their configuration remain part of the host's trust boundary. Hooks cannot observe every hosted tool or prevent arbitrary same-user processes from changing files. Recheck path evidence on every request; filesystem races still require host enforcement.

## Policy profiles

Without a profile the engine is strict (everything above). An organization can install one profile file that widens automatic approval without changing the checks themselves:

```json
{
  "version": 1,
  "mode": "permissive",
  "cloudWrites": "human",
  "humanPatterns": ["^npm install"],
  "scratchRoots": ["/tmp"]
}
```

```sh
policy-manager profile validate policy.json
policy-manager profile install policy.json   # writes ~/.config/agent-corpus/policy-manager/policy.json
```

The service reads the profile only from that user directory (`$XDG_CONFIG_HOME` honored). It must be a regular, non-symlink file owned by the user, not group/world writable, and outside every Git checkout, so an agent cannot rewrite its own rules from a worktree. On Windows, POSIX owner and mode bits do not exist, so only the regular-file, non-symlink and outside-Git checks apply and the user-profile ACL is the trust boundary. `cd <literal>` is tracked, and each later command is judged in every directory it could run in. Git long-option abbreviations are treated as the full option. An invalid or untrusted profile logs `profile ... invalid-using-strict` and the session stays strict. Each session records the profile mode and SHA-256 digest in `audit.jsonl`.

`permissive` approves compound commands (`;`, `&&`, `||`, `|`, quotes, redirects, `VAR=x` prefixes) when every simple command is acceptable, and approves unknown executables and interpreters with inline code. It still sends these to a human: deletion (`rm`, `find -delete`, `xargs rm`), `sudo`, `git reset --hard`, `git clean`, forced or mirror pushes, discarding checkouts and restores, stash and reflog destruction, `gh` deletions and security endpoints, cloud deletion and credential retrieval, infrastructure destroy, `npm publish`, destructive HTTP verbs, piping into a shell, ssh and database clients, builtins that run a string later (`eval`, `source`, `trap`, `alias`), printing the environment, writes outside linked feature worktrees and `scratchRoots`, and protected or credential paths. `humanPatterns` adds organization-specific expressions.

#### Shell syntax in permissive mode

Every command that could run is judged, not only the first. Understood: `;`, newlines, `&&`, `||`, `|`, `&`, comments, quoting and escapes, line continuation, redirections (including `&>`, `|&`, here-strings and quoted-delimiter heredocs), `( ... )`, `{ ...; }`, `for`, `while`, `until`, `if`, `case`, `$(...)`, backticks and `<(...)`.

- **Variables.** `NAME=value`, `export NAME=value` and `for NAME in a b c` give a variable a known value; the command is then judged with the value substituted, in every directory and for every value it could take. A variable assigned in only some branches, in a loop, or from a command, glob or `read` has an unknown value, as does any environment variable the script did not assign. An unknown value is accepted only as an argument to `echo`, `printf` with string conversions, `test`/`[` without numeric tests, `true`, `false`, `basename` and `dirname`, and as the value of a commit or PR message option (`git commit -m "$(...)"`, `gh pr create --body "$(...)"`). It is never a program, option, path, `cd` target or redirection target. Environment variables other than a short list (`PWD`, `USER`, `TMPDIR`, ...) need a human, because they can hold credentials.
- **Command substitution** and process substitution run first: the inner command is judged with the same rules.
- **Heredocs.** A quoted delimiter (`<<'EOF'`) is literal text. An unquoted delimiter is accepted only when the body has no `$`, backtick or backslash. A shell fed by a heredoc (`bash <<'EOF'`) has its body judged as a script. An interpreter fed by a heredoc or `-c` is treated like inline code: the code is scanned for file deletion, process creation, string evaluation and protected paths, and anything flagged goes to a human; code piped in from elsewhere always does.
- **Compound commands.** Branches are judged on copies of the state and merged; a loop's assigned variables are unknown inside it and afterwards, and a `cd` inside a loop or pipeline needs a human.
- **Still sent to a human:** brace expansion, arithmetic (`$((`, `$[`, `(( ))`), `${X:-y}` and other parameter forms, `$'...'`, function definitions, unquoted heredocs whose body expands, and scripts that expand to more than a few hundred commands. `cloudWrites: "allow"` also approves non-destructive cloud changes.

Measure a profile against real usage with `policy-manager replay ~/.claude/projects --profile policy.json`: it replays the Bash commands recorded in Claude Code transcripts through the evaluator (nothing is executed) and prints the approval rate with and without the profile, plus the most common reasons that still need a human. Reports include short command excerpts, so keep them local.

Protected names (`.claude`, `.agent-config`, `AGENTS.md`, ...) are judged relative to the repository root, so a linked worktree under `<repo>/.claude/worktrees/<name>` is ordinary code while `<worktree>/.claude/settings.json` stays protected. `git config` is limited to a short allowlist of local, non-executable keys; hooks, aliases, credential helpers, URLs and `--global` always need a human. Read-only cloud verbs (`list`, `show`, `describe`, `get-*`) are approved beyond the exact catalog unless the arguments name credentials or override the endpoint.

Deleting a branch is automatic only when it is already merged into `origin/main` (or `master`): reachable from it, or patch-equivalent to a squash or rebase merge. Remote deletion also needs `origin` and a `git ls-remote` tip that matches the fetched tracking ref, so unfetched commits block it. Evidence uses the locally fetched default branch; fetch first for very recent merges.

## Service, cache, and logs

The service uses a Unix socket on macOS/Linux and a named pipe on Windows. A random session token authenticates local requests. Files use owner-only modes on Unix. On Windows, the operating system's temporary-directory ACL is the access boundary; Unix modes do not establish Windows ACL isolation. Other processes running as the same user are outside this boundary.

The cache belongs to the service process and is scoped to harness plus session ID. It holds at most 512 cloud-inspection decisions, expires entries after one minute, and evaluates policy before lookup. Filesystem and branch evidence is never cached. `SessionEnd` or `policy-manager stop <harness> <session-id>` stops the service. An idle service stops after 30 minutes. Requests restart it when necessary; crash-created stale sockets require inspection rather than unsafe automatic deletion.

`SessionStart` reports the private temporary directory containing `audit.jsonl`. Each request and decision is recorded before an approval is returned. The log stores versioned event envelopes, readable action summaries, opaque session identifiers, request hashes, and hashed targets. It excludes paths, argument values, source text, credentials, and model explanations. Compare request hashes against the original request in the harness transcript during an investigation. Logs rotate at 10 MiB per segment and stop accepting writes at 100 MiB total. Earlier segments remain available through `audit-log query` and `audit-log export`; no records are automatically deleted. Logs remain after normal shutdown and can disappear during operating-system cleanup. Copy them before cleanup when needed.

Logging failure, malformed requests, service failure, and unknown semantics never produce an automatic approval. Permission hooks fall through to native human handling. Pre-tool failures exit 2. Host timeout behavior differs: Copilot command-hook timeouts fall through to its normal permission flow. Codex does not support `ask` in `PreToolUse`: it parses the value, marks the hook failed and runs the tool anyway. A decision that needs a human is therefore returned to Codex as a `deny` whose reason says the command was not run and that approving it in chat does not unblock it (the decision is deterministic, so a retry is denied again); there is no in-Codex button to approve it. The user runs the command themselves or changes the policy profile. An ambiguous cloud request is the one exception: its reason points to the session policy-manager agent, and a classification of approved is accepted for the session, so a retry passes. Codex's own approval prompt (`PermissionRequest`) is left to Codex for the requests it would ask about, and an approval is returned as `allow`.

## Audit API and reported outcomes

Every policy event uses the shared audit-log schema: `schemaVersion`, unique `eventId`, UTC `timestamp` and `observedTimestamp`, `eventName`, `source`, opaque `sessionId`, optional `requestId`, `severityText`, `summary`, and `attributes`. The existing private session directory remains the storage location. `requestId` is the normalized request hash; repeated identical requests share correlation, and distinct `eventId` values identify each observation.

```sh
audit-log query /private/session-directory --request-id REQUEST_HASH
audit-log export /private/session-directory > investigation.jsonl
policy-manager record codex session-example < outcome.json
```

The record command accepts a host-reported event:

```json
{ "event": "human-response", "requestHash": "<64-character request hash>", "response": "approved" }
```

Or an execution report:

```json
{
  "event": "execution-result",
  "requestHash": "<64-character request hash>",
  "status": "succeeded",
  "exitCode": 0,
  "durationMs": 12
}
```

Human responses are `approved` or `denied`. Execution statuses are `completed`, `succeeded`, `failed`, `cancelled`, or `unknown`. `unknown` is recorded for Codex when the hook payload exposes no exit status, which is the usual case for a Bash result. Reports use the source `policy-manager.adapter-report`. They are observations declared by the caller and never modify permission decisions or caches. The API does not authenticate a human identity. A denial policy remains a human decision even after an approval report is recorded.

Generated post-tool hooks record execution reports for the supported tool matcher. Claude and Copilot also get failure hooks. Codex uses `PostToolUse`, which also runs after commands that exit non-zero. Codex sends a Bash result as the command's output text only, with no exit code and no duration, so the adapter records `unknown` for Codex rather than `completed` or `succeeded`; a structured `exit_code` is used when one is present. Claude and Copilot record `completed` when an exit code is absent. Output text and error bodies are discarded. Human responses require an explicit report from the host; the native hooks do not provide a universal human-response signal.

The shared logger redacts structured sensitive fields, validates events, locks concurrent access, and flushes each append. Queries cover active and rotated segments. Busy storage, a stale lock, incomplete records, capacity limits, or write failures prevent automatic approval. The initial API is a library plus CLI; an additional resident logging server is deferred until another consumer needs one.

## Validation and support

Tests exercise real service processes and native-shaped hook payloads for all three CLIs. These protocol tests are separate from authenticated live model sessions. CLI versions inspected during development: Claude Code 2.1.316, Codex CLI 0.166.0, Copilot CLI 1.0.104. Full live-session approval, resident-agent startup, and desktop validation remain rollout work. Do not describe generated hook configurations as an installed policy.

Verified documentation, November 5, 2026:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference)

Exit codes: 0 means a protocol response was returned; inspect `decision` before acting. 1 means invalid input or service failure. Pre-tool hook failures use 2. Diagnostics use stderr and contain no raw request data.
