# @agent-corpus/policy-manager

A coding-agent-independent permission evaluator. It starts a private background service for each session, verifies ordinary code operations and cloud inspection commands, and records requests and decisions in a temporary audit log. Uses the shared `@agent-corpus/audit-log` package and calls no model API itself.

Every request goes through three steps (see **How a request is decided**): a deterministic engine approves what it can prove safe; otherwise the hook asks an AI classifier, run through the user's own logged-in harness CLI, and approves what it judges recoverable; otherwise it asks the person and waits, and remembers a "yes" for the session.

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

The `SessionStart` hook starts one service per session and tells the agent, in one line, how requests are decided. It does not ask the agent to classify anything: classification happens inside the hook.

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

Setup also installs a small launcher named `pm` that runs this CLI, so a user can type `pm approve --last`: `~/.local/bin/pm` (a Node script, mode 0755) on macOS and Linux, `%LOCALAPPDATA%\agent-corpus\bin\pm.cmd` on Windows. It carries a marker with the version that wrote it. Setup replaces only a launcher it wrote for the same or an older version; a newer one, or a `pm` it did not write, is left alone and reported. Setup never edits `PATH`: the result's `shim.onPath` says whether the directory is on it, and the next steps say how to add it. `--shim-dir <directory>` puts the launcher elsewhere; with `--config-dir` and no `--shim-dir`, setup leaves the launcher alone.

`--dry-run` prints the target path, proposed managed hooks, and next steps without writing files or printing existing settings. `--config-dir <directory>` selects a harness configuration root for portable profiles or testing. Defaults respect `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `COPILOT_HOME`, then use the standard user directories listed above. Setup refuses to activate an entrypoint inside a Git checkout, including an npm link into a checkout. Source builds can preview with `--dry-run`.

Start a new session after setup. Codex still requires explicit review and trust through `/hooks`; setup does not grant that trust. Existing sandbox controls and host permission rules continue to apply.

Every managed hook gets an explicit timeout of 45 seconds (Codex `SessionEnd`: 3, its limit), above the classifier's own timeout (15 s for Claude and Codex, 20 s for Copilot) plus the service's wait. This matters most for Copilot, whose default hook timeout is 30 seconds and whose command hooks fail open on a timeout. Setup also adds `PostToolUse` and, for Claude Code and Copilot, `PostToolUseFailure`, which remember a person's answer (step 3).

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

Run `policy-manager review codex session-example`. The response includes `decision` (`approve`, `human`, `deny`, or `native` for no decision, which leaves the request to the harness), `category`, `reason`, `requestHash`, `cache`, and `cached`. It runs the same three steps as the hooks. The library exports the evaluator.

Categories are `code-read`, `worktree-write`, `temp-write` (a recoverable write outside any repository), `cloud-read`, `git-read`, `impactful-write`, `destructive`, `sensitive`, and `unknown`.

`policy-manager classify <harness> <session-id>` still accepts a recorded classification (`{requestHash, category, confidence, recoverable, rationale}` on standard input) for a request a person was asked about, for compatibility. Nothing asks an agent to run it any more.

## How a request is decided

1. **The deterministic engine** approves what it can prove safe (see **Policy** and **Policy profiles**). Unchanged.
2. **The AI classifier, in the hook.** Anything else the engine escalates is classified synchronously, inside the hook, by the harness's own CLI (below). The request is approved when the answer is `recoverable` with `confidence >= 0.95` and a category other than `sensitive` or `unknown`. Hard human items skip this step.
3. **The person.** Otherwise the person is asked and the harness waits. Before asking, the user's own harness permission rules are applied (below). Claude Code and Copilot ask in their own prompt; a "yes" is remembered for the rest of the session with the same scope as `approve --session`, so the same kind of request is not asked again. Codex cannot ask: it gets a deny with `pm approve --last` and stops (see **Approving from the terminal**).

The user's own deny or ask rules beat every approval here: when one matches, the hook makes no decision and the harness applies the rule. An allow rule counts as the person's answer.

### Hard human items

These go straight to step 3. They are never sent to the classifier, and no classification approves them:

- credential or secret retrieval, and reads of credential paths;
- protected configuration: the policy profile, harness settings and hooks (`.claude/settings*.json`, `.claude/hooks/`, `~/.claude.json`, `.codex/config.toml`, `.codex/hooks.json`, `.codex/hooks/`, `.codex/rules/`, `.copilot/config.json`, `.copilot/settings.json`, `.copilot/hooks/`, `.github/hooks/`, including under `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `COPILOT_HOME`), and protected repository paths;
- unrecoverable loss: force and mirror pushes and `+` refspecs, deleting a branch whose work is not verified merged, forced worktree removal and `git worktree prune`, and `git clean`;
- commands matching the profile's `humanPatterns`;
- an agent running `approve` itself, or a classification record for another session.

The check reads the command the way the shell runs it: quotes and backslashes removed, `eval`, `sh -c` and `$(…)` bodies read as commands, wrappers (`env`, `sudo`, `timeout`, `xargs`, …) skipped, `cd` targets followed for relative paths, and Git aliases resolved with a read-only `git config --get alias.<name>`. It is unioned with a plain-text reading of the command, so a script piped into a shell, `bash <(…)`, `find -exec` or inline interpreter code still counts. A false match asks rather than approves. Requests the classifier cannot judge from what it is shown (an incomplete request, another working directory, an unreadable patch, a custom environment) also go to a person.

### The classifier

| Harness     | Command (no shell, from a private empty directory)                                                                                                                                                                                                                                                                                 | Timeout |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Claude Code | `claude -p --model <model> --tools "" --setting-sources "" --settings '{"disableAllHooks":true,"autoMemoryEnabled":false}' --no-session-persistence --strict-mcp-config --disable-slash-commands --permission-mode dontAsk --max-turns 2 --output-format json --json-schema <schema> <prompt>`; the answer is `.structured_output` | 15 s    |
| Codex       | `codex exec --ephemeral --ignore-user-config --ignore-rules --disable hooks --skip-git-repo-check -s read-only -c approval_policy="never" -c model_reasoning_effort="low" -m <model> -C <empty dir> --output-schema <schema.json> -o <out.json> <prompt>`, standard input closed                                                   | 15 s    |
| Copilot     | `copilot -p <prompt> --model <model> --available-tools "" --no-custom-instructions --disable-builtin-mcps --no-ask-user --no-auto-update --disable-client-telemetry --output-format json`, with `COPILOT_HOME` set to a private scratch directory whose `settings.json` is `{"disableAllHooks":true}`                              | 20 s    |

Copilot still authenticates in that scratch home: its stored login lives in the system credential store (the Keychain on macOS), not in `COPILOT_HOME`, and `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` are passed through when set. A login stored in plain text (`storeTokenPlaintext`) lives in `COPILOT_HOME` and does not reach the scratch home, so the classifier fails and the person is asked. On Windows only an executable (`.exe`) CLI is run, since `.cmd` launchers need a shell; otherwise the person is asked.

The prompt gives the command (at most 6000 characters; a longer one goes to the person), the working directory, Git facts (repository root, branch, default branch, main checkout or linked worktree), each path the command names with whether it is in the linked feature worktree, the main checkout, the temp directory or a session scratch directory, and whether this session created it, and the engine's reason. Deleting scratch files, screenshots, temp directories or files the session created is approvable.

Verdicts are cached for the session by request hash, and concurrent hooks for one request share one run. Any failure (the CLI is not installed or not logged in, a nonzero exit, a timeout, output that is not JSON or not the schema) asks the person; it never approves. A missing CLI is not tried again in that session. After 50 AI approvals in a session, further requests go to the person.

Configure it in the profile:

```json
{
  "version": 1,
  "mode": "permissive",
  "classifier": {
    "claude": { "model": "haiku" },
    "codex": { "model": "gpt-6-luna" },
    "copilot": { "model": "auto" }
  }
}
```

Each harness uses its own CLI; the models above are the defaults. `"enabled": false` turns the classifier off, so everything the engine escalates goes to the person. An unknown key or an invalid model name makes the profile invalid, and an invalid profile is replaced by the strict default.

**Privacy.** Commands, paths and the facts above are sent to the user's own model provider through their own logged-in CLI, under that account's terms. Nothing is sent anywhere else. The audit log records each classification's CLI, model, latency and verdict, never the prompt.

### The user's own permission rules

Read, never written, before asking:

- **Claude Code** ([permissions](https://code.claude.com/docs/en/permissions)): `permissions.allow`, `ask` and `deny` in `settings.json` under `CLAUDE_CONFIG_DIR` (default `~/.claude`) and the project's `.claude/settings.json` and `.claude/settings.local.json`. Deny, then ask, then allow; the first match decides. `Bash(cmd)` is exact, `Bash(cmd *)` and `Bash(cmd:*)` are prefixes, and `*` matches any text. A compound command (`&&`, `||`, `;`, `|`, `|&`, `&`, newlines) is allowed only when every subcommand is; deny and ask rules match any subcommand, including `$(…)` bodies. `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob` and bare `xargs` are stripped; `watch`, `setsid`, `ionice`, `flock` and `find -exec`/`-delete` are never allowed by a rule. `Read(...)` and `Edit(...)` path rules use the documented `//`, `~/`, `/` and relative forms, and `Edit` rules cover `Write`.
- **Codex** ([rules](https://developers.openai.com/codex/rules), [configuration](https://developers.openai.com/codex/config-reference)): `prefix_rule(pattern=[...], decision="allow"|"prompt"|"forbidden")` in `*.rules` under `CODEX_HOME/rules` (default `~/.codex/rules`), and in the project's `.codex/rules` when `config.toml` marks the project trusted. A linear chain of plain commands is checked per command and the strictest decision wins; anything else is one `bash -lc` invocation. Codex documents no other command allowlist in `config.toml`.
- **Copilot** ([allowing tools](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools)): none. Its allow and deny lists are the `--allow-tool` and `--deny-tool` flags, which apply to one session and are not saved; the format of saved per-location approvals is not documented, and trusted folders gate file access, not commands.

An allow rule approves, audited with `userAllowRule`. It never approves an agent running `approve` itself.

### Remembering an answer

Claude Code's `PreToolUse` carries a `tool_use_id`. When the hook asks, the session records it; the `PostToolUse` (or `PostToolUseFailure`) for that id means the person said yes, and a rejection is not counted. Copilot's `postToolUse` carries no id, so a pending prompt is matched by its request hash (tool, arguments and working directory). The answer gets the same scope as `approve --session`: the protected root, the matching `humanPatterns` entries, or for other rules the exact command, in the same checkout. Unknown, sensitive and destructive requests, possible unrecoverable loss and credential reads are approved once only.

## Recording and review

The audit log gets `classification-requested` the first time a request reaches the classifier (with the command redacted under a permissive profile: secret-looking values, URL credentials and long tokens are replaced and the text is capped; the strict default keeps only a vocabulary summary), `ai-classification` (CLI, model, latency, and the verdict or the failure reason), `classification` (category, confidence, recoverable, redacted rationale), `decision` (with the stage `approved`, `denied` or `fallback`, and `userAllowRule` or `userRule` when the user's own rule decided), `classification-fallback` (with the failure reason), and `human-response` and `human-grant` for a remembered answer. Review them across sessions:

```sh
policy-manager review-classifications [--since 2026-11-12T00:00:00Z] [--json]
```

The report shows how many ambiguous requests were approved, denied, fell back to a person (and why), and never resolved; a confidence histogram; every AI-approved command with its outcome; approved commands that then failed; and commands a person later denied. It reads the session logs under the temporary directory, which the operating system clears after a few days, so run it within two days of starting. `replay` prints how many escalations in recorded transcripts would go to the classifier instead of a person; `replay --classify` runs the real classifier on the newest escalations (`--limit`, default 300, four at a time) and reports engine, AI and user-rule approvals, what still asks and why, classifier errors and latency. It sends those commands to your model provider and executes nothing.

## Approving from the terminal

Codex cannot ask in `PreToolUse`, so a request that needs a person is denied, and approving it in chat does not change the decision. The deny reason leads with what to do:

```text
⏸ Waiting for your approval. Not run: Protected path requires human approval.
Run in your own terminal, then say "retry":
  pm approve --last
Add --session to also allow writes under /tmp/wt/.agent-config for the rest of this session.
Agent: stop now and end your turn; approving it in chat does not unblock it. Show the user the command above exactly, in a code block. Never run it yourself.
Request <64-character request hash>.
```

`pm approve --last` approves the newest request that any running policy session of this user sent to a person in the last 15 minutes. It shows the harness and session, the tool, the redacted request, the rule, and (with `--session`) the scope, then asks y/N; it refuses to run without an interactive terminal. To approve one exact request instead:

```sh
policy-manager approve <claude|codex|copilot> <session-id> <request-hash> [--session]
```

The deny reason uses `pm` when the managed launcher (see **Install native hooks**) for this version is installed and its directory is on `PATH`, and `node "<cli>" approve --last` otherwise. Then the agent retries the same request unchanged.

- **Once (default).** The next review of that exact request is approved, once per hook phase (`PreToolUse`, then `PermissionRequest`), and the grant is spent.
- **`--session`.** Also approves later requests in this session that hit the same rule for the same scope: a protected-path write under the same protected root of the same checkout (`<worktree>/.agent-config`, not `.claude` or another worktree), the same `humanPatterns` entries in the same checkout, or, for other rules, the exact same command in the same checkout. `approve --session` prints the scope before asking. Shell commands are covered only when they are a single simple command, so nothing else in a script hides behind the rule. Credential and secret reads, possible unrecoverable loss (force pushes, deleting unmerged work) and requests whose effect the engine could not determine (category `unknown`, such as an interpreter script) are approved once only, even with `--session`; the deny reason offers `--session` only when it applies.

Each grant is audited as `human-grant` (and `human-response` `approved`), and each use as `human-grant-use` with its scope. A shell command that runs or names a policy-manager `approve`, at any nesting (`sh -c`, `npx`, wrappers), always goes to a person, so an agent that follows the deny reason cannot approve its own request. The guard is lexical and the service trusts any holder of the session token, so it is not a boundary against an agent that deliberately works around it. Grants live in the session's policy service; if it restarts (it exits after 30 idle minutes), retry the request and approve the new hash. Claude Code and Copilot ask natively and do not need this, though it works for them too.

## Policy

What the list below says "requires human approval" is what the deterministic engine does not approve. It then goes to the AI classifier, unless it is a hard human item (see **How a request is decided**).

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
  "scratchRoots": ["/srv/scratch"],
  "mcpReadOnly": ["mcp__github__get_issue", "mcp__github__list_pull_requests"]
}
```

```sh
policy-manager profile validate policy.json
policy-manager profile install policy.json   # writes ~/.config/agent-corpus/policy-manager/policy.json
```

The service reads the profile only from that user directory (`$XDG_CONFIG_HOME` honored). It must be a regular, non-symlink file owned by the user, not group/world writable, and outside every Git checkout, so an agent cannot rewrite its own rules from a worktree. On Windows, POSIX owner and mode bits do not exist, so only the regular-file, non-symlink and outside-Git checks apply and the user-profile ACL is the trust boundary. `cd <literal>` is tracked, and each later command is judged in every directory it could run in. Git long-option abbreviations are treated as the full option. An invalid or untrusted profile logs `profile ... invalid-using-strict` and the session stays strict. Each session records the profile mode and SHA-256 digest in `audit.jsonl`.

`permissive` approves compound commands (`;`, `&&`, `||`, `|`, quotes, redirects, `VAR=x` prefixes) when every simple command is acceptable, and approves unknown executables and interpreters with inline code. It sends these to a person, except for the scratch deletions below and an `rm` inside a linked feature worktree, which the classifier may approve as recoverable: deletion (`rm`, `find -delete`, `xargs rm`) and `git reset --hard`, checkouts and restores that discard work (see **Recoverable deletions and resets** for what Git can undo), `sudo`, `git clean`, forced or mirror pushes, stash and reflog destruction, `gh` deletions and security endpoints, cloud deletion and credential retrieval, infrastructure destroy, `npm publish`, destructive HTTP verbs, piping into a shell, ssh and database clients, builtins that run a string later (`eval`, `source`, `trap`, `alias`), printing the environment, writes outside linked feature worktrees, `scratchRoots` and the system temp directory, and protected or credential paths. `humanPatterns` adds organization-specific expressions.

Writes outside every repository to the system temp directory (`os.tmpdir()`, plus `/tmp` and `/private/tmp` off Windows) are approved as `temp-write`, after symlinks (dangling ones too) and `..` are resolved. Repository rules still apply to a checkout that lives in the temp directory. The policy service's own `acp-*` session directories, hard-linked files, protected names and credential paths are never temp writes. A temp root that contains the home directory grants nothing.

Deleting disposable files is approved too (`Delete within a scratch directory`): `rm`, `rmdir`, `unlink` and `find ... -delete` (without `-exec`, `-L` or `-follow`) when every target resolves strictly inside a `scratchRoots` entry or the system temp directory, never the root itself. A glob may appear only in the last component, and its directory must itself be strictly inside a root, so `rm -rf /tmp/*` still asks. Targets in or holding a Git repository (unpushed work), `acp-*` policy state, and protected or credential names still go to a person.

A path is resolved when the hook runs, before the script does, so a symlink that an earlier command in the same script creates is invisible to it. Temp writes and scratch deletions are therefore approved only until the script runs a command that is not known to create no symlink. The known commands print, read, or write regular files: `echo`, `cat`, `sort`, `grep`, `sed`, `tee`, `touch`, `mkdir`, `rm`, `cp` without options that copy links, read-only `git` subcommands and `git init`, and a few others. A shell's `-c` script is judged with the same state. After anything else (`cp -R`, `mv`, `ln`, `tar`, `xargs`, an interpreter, an unknown program) a later temp write or scratch deletion goes to a person. In a loop, a pipeline or a background job a later command can run first, so such a command there after an approved temp path also goes to a person. Writes inside linked feature worktrees are not affected.

Every other argument is a possible file operand and is checked for credentials: by name (`id_rsa`, `credentials`, `secrets.json`, `.env`, `*.pem`, `*.key`, also bare, as in `cat id_rsa` from `~/.ssh`), and, when it exists, by its path resolved against the tracked working directory, so a symlink to a key or any file in a `.ssh` directory counts. A glob (`cat *`, `cat id_*`, `cat .*/*`) is expanded one component at a time against the directories it names; more than 5000 entries in total, an entry that cannot be read or resolved, or a zsh recursive `**`/`***` component counts as sensitive. `*` is assumed not to match dot files, so a shell with zsh `GLOB_DOTS` or bash `dotglob` set can reach dot files a plain `*` check misses. File-name pattern values (`grep --include`, `rg -g`, `find -name`/`-path`) are matched below the searched paths, so they are judged by name only. Credential-path checks skip words that are text, not paths: a `sed` script (but not the files its `r`, `w` or `e` commands name, nor `-f`), a `grep` or `rg` pattern, `gh` `--body`, `--title`, `--jq`, `--template` and `--notes` values, and `echo`/`printf` arguments, which are judged by name only when they look like a path. Other programs keep the conservative check.

`cp` and `ln` sources are reads, so copying or linking out of a main checkout into the temp directory is a temp write; only the destination (the last operand, `-t` or `--target-directory`, or the base name of a lone `ln` operand in the working directory) is checked as a write. With a backup suffix (`-b`, `-S`, `--backup`, `--suffix`) or a hard link (`ln` without `-s`, `cp -l`/`--link`) every operand is checked as a write, since a later write through a hard link changes its source; a hard-linked file is never a scratch or temp write. `chmod`'s mode and `chown`'s owner are not paths, except that BSD `chmod -N`/`-E`/`-C`/`-i`/`-I` take no mode, so every operand is a file.

`grep --include=*.md`, `--exclude`, `--exclude-dir` and `rg -g`/`--glob`/`--iglob` with an unquoted glob value are approved: the option name is literal, so expansion only yields more of the same option. A glob in any other option or in the command name still needs a human.

#### Shell syntax in permissive mode

Every command that could run is judged, not only the first. Understood: `;`, newlines, `&&`, `||`, `|`, `&`, comments, quoting and escapes, line continuation, redirections (including `&>`, `|&`, here-strings and quoted-delimiter heredocs), `( ... )`, `{ ...; }`, `for`, `while`, `until`, `if`, `case`, `$(...)`, backticks and `<(...)`.

- **Variables.** `NAME=value`, `export NAME=value` and `for NAME in a b c` give a variable a known value; the command is then judged with the value substituted, in every directory and for every value it could take. A variable assigned in only some branches, in a loop, or from a command, glob or `read` has an unknown value, as does any environment variable the script did not assign. An unknown value is accepted only as an argument to `echo`, `printf` with string conversions, `test`/`[` without numeric tests, `true`, `false`, `basename` and `dirname`, and as the value of a commit or PR message option (`git commit -m "$(...)"`, `gh pr create --body "$(...)"`). It is never a program, option, path, `cd` target or redirection target. Environment variables other than a short list (`PWD`, `USER`, `TMPDIR`, ...) need a human, because they can hold credentials.
- **Command substitution** and process substitution run first: the inner command is judged with the same rules.
- **Heredocs.** A quoted delimiter (`<<'EOF'`) is literal text. An unquoted delimiter is accepted only when the body has no `$`, backtick or backslash. A shell fed by a heredoc (`bash <<'EOF'`) has its body judged as a script. An interpreter fed by a heredoc or `-c` is treated like inline code: the code is scanned for file deletion, process creation, string evaluation and protected paths, and anything flagged goes to a human; code piped in from elsewhere always does.
- **Compound commands.** Branches are judged on copies of the state and merged; a loop's assigned variables are unknown inside it and afterwards, and a `cd` inside a loop or pipeline needs a human. A `cd` can fail, so the directory it started from stays possible, except in an unbroken `&&` chain (`cd X && cmd`) or an `if cd X; then` body, which run only after it succeeded. `cd X; cmd`, `cd X || cmd` and `! cd X && cmd` are judged in both directories. A `for` loop over literal items is judged once per item. The body of an `if` sees what its condition assigned when the condition is an `&&` chain.
- **Other repositories.** A session started in one repository may change any other Git repository when the writes land in a linked feature worktree: `cd <worktree> && <edit>`, and commits, pushes and `gh pr create` from there. From any clone, `git fetch origin` and `git worktree add` are approved; a new worktree inside the main checkout must go under `.worktrees/` or `.claude/worktrees/`, and `-B` needs a human. Writes to a main checkout still need a human. The strict profile approves `git worktree add [--no-track] <path> -b <new branch> origin/main` (either order, `main` or `master`) under those two directories.
- **Functions.** `name() { ...; }` is recorded, and each call judges the body with the call's arguments as `$1`, `$2`, .... A function defined on only some paths, called through a wrapper or variable (`time f`, `X=f; $X`), named like a special builtin, or nested more than four calls deep needs a human. `set -- words` sets the positional parameters the same way. A value with blanks is not split (zsh does not split an unquoted parameter, bash does), so the positions after it are unknown. `shift` and any other `set` with words make them unknown. Functions zsh or bash runs with no call (`TRAPxxx`, `chpwd`, `precmd`, `preexec`, `periodic`, `zshexit`, `zshaddhistory`, the not-found handlers) need a human. Positional parameters never count as environment variables; outside a call or `set --` they are unknown.
- **Parameter forms.** `${X:-w}`, `${X:+w}`, `${#X}`, `${X#p}`, `${X##p}`, `${X%p}`, `${X%%p}` and `${X:o:l}` with a literal word or pattern are computed when `X` is known and are unknown otherwise; `X` is still checked as an environment variable. `$'...'` is decoded and judged as a literal. An assignment value starting with `~` or `~/` is the home directory.
- **`while read`.** When the loop reads a literal here-string or quoted heredoc, the body is judged once per line with the fields `read` assigns. This applies only when nothing in the body can read the loop's standard input (only `echo`, `printf`, `test`, `ls`, read-only `gh pr`/`issue`/`run` views and similar, or commands with their own input), since a body that consumes part of a line changes what the next `read` sees.
- **Computed substitutions.** `$(dirname x)`, `$(basename x [suffix])` and `$(pwd)` with known arguments (and a single possible directory for `pwd`) are replaced by their output. Any other substitution output stays unknown: no read-only command is safe for an arbitrary argument here, since `ls`, `cat` and `find` reveal credential files, and options such as `wc --files0-from`, `gh --jq '$ENV...'` and `git log --output` read files or the environment or write files.
- **Variables after a `cd` chain.** `cd /abs/dir && X=1; use $X` treats `X` as assigned when the `cd` is the script's first command and the directory exists and can be entered at evaluation time. An earlier command could remove it, so a later `cd` is still assumed able to fail. Another process changing the directory before the script runs is the remaining window. This affects variables only: `use` is still judged in the starting directory too.
- **Variables after an assignment chain.** `S=/abs && H=x; use $S $H` treats `H` as assigned: a bare assignment with no command substitution and no redirection cannot fail, so the `&&` chain always reaches `H=x`. This holds only for uppercase names the shell does not reserve. zsh's lowercase specials, read-only or numeric specials (`UID`, `SECONDS`, `BASH*`, `ZSH*`, ...), a value with `$(...)`, `export NAME=value` and a prefix assignment (`X=1 cmd`) can fail or do not persist, so the chain may stop there and a later name is still an environment variable. A value used as the program (`P=rm; $P -rf x`) is resolved and judged as that program. The remaining window is a `readonly` or `typeset -i` that the user's shell startup files set on a name outside that list (such as `HISTFILE`): bash 5 in default mode may then return 1 without exiting, so the chain could stop there. That is outside what the script controls and is accepted.
- **Still sent to a human:** brace expansion (`{a,b}`, `{1..3}`; `{}` and `@{u}` are literal), arithmetic (`$((`, `$[`, `(( ))`), arrays, other parameter forms (`${X:=y}`, `${!X}`, `${X/a/b}`), `function name` definitions, unquoted heredocs whose body expands, and scripts that expand to more than a few hundred commands. `cloudWrites: "allow"` also approves non-destructive cloud changes.

#### Harness tools approved by default

Under the permissive profile, a harness tool that is not a shell, file, patch or MCP tool is approved without a prompt or classification: task control (`TaskStop`, `TaskOutput`), scheduling the session's own wakeup, listing agents, loading tool schemas, asking the user, plan mode, and tools a harness adds later. Shell, file and patch tools (`Bash`, `exec_command`, `Read`, `Write`, `Edit`, `apply_patch`, `Grep`, `Glob`, `view_image`, and `Monitor`, which runs a command) always get the engine's checks. So does any tool that runs code, writes to a running command, or touches files, whether listed (Codex `shell_command`, `local_shell`, `write_stdin`; Copilot `write_bash`) or only named like one (a name containing `bash`, `shell`, `exec`, `stdin`, `command`, `repl`, `eval`, `python`, `run`, `file`, `delete`, `move`, `edit` and similar), so a new one fails closed. A false positive such as `BashOutput` only costs a classification. MCP tools follow `mcpReadOnly`. The strict profile approves none of them by default.

`toolsDeny` keeps chosen tools on today's path, an AI classification for each call: `{ "claude": ["SendMessage", "WebFetch"], "codex": [], "copilot": [] }`, exact names, at most 100 per harness. An unknown harness, a non-list, or a name that is not a tool name makes the profile invalid (strict). The built-in deny list is empty.

Each default approval's audit `decision` record carries `defaultTool` with the tool name. `review-classifications` lists these tools newest first by when each was first seen, so a tool a harness newly added is noticed and can be put in `toolsDeny`.

#### Credential helpers

Reading a credential always goes to a person, except through a script listed in `credentialHelpers` (permissive profile only). A helper reads a secret for one narrow job, such as posting a review as a GitHub App:

```json
"credentialHelpers": [
  {
    "path": "tools/review-bot.mjs",
    "remotes": ["github.com/example-org/"],
    "args": [
      ["--repo", "<repo>", "check"],
      ["--repo", "<repo>", "gh", "api", "repos/<repo>/pulls/<int>/reviews", "--input", "<file>"],
      ["--repo", "<repo>", "gh", "pr", "review", "<int>", "-R", "<repo>", ["--approve", "--comment"], "--body-file", "<file>"]
    ]
  }
]
```

`node <script> <args>` is approved, and named in the audit `decision` record as `credentialHelpers: ["<path>#<shape index>"]`, only when all of these hold:

- The checkout comes from a listed remote. `remotes` (required) lists normalized prefixes such as `github.com/example-org/`: a lowercase host, then at least an owner, where a trailing `/` makes it a prefix. The checkout's `remote.origin.url` (https, ssh or `git@host:` form, normalized to lowercase `host/owner/repo` without `.git`) must match one. It must equal what `git remote get-url origin` resolves, so no `url.*.insteadOf` rewrite applies, and there must be no `remote.origin.pushurl`. A clone of a local or other repository, or a `git init`, has an origin that does not match.
- The script, however it is named (relative, absolute, from another directory), is the regular file at `<checkout>/<path>` with no symlink on the way, tracked, and identical to the committed file on the default branch of `origin`. The branch is found by full ref name only (`refs/remotes/origin/HEAD` when it points into `refs/remotes/origin/`, else `refs/remotes/origin/main`), so a tag or branch named `origin/HEAD` cannot stand in for it, and every lookup ignores replace refs. The committed blob's bytes are compared in Node with the working file: an exact match, or, when the blob has no CR, a match once the file's CRLF line ends become LF (a `core.autocrlf` checkout). No clean filter or `.gitattributes` setting applies. A local edit makes it a different script.
- The arguments match one listed shape exactly, word for word. A token is a literal, a list of literal alternatives, or a word with placeholders: `<repo>` (`owner/name`, each part starting with a letter or digit), `<int>`, `<sha>` (7 to 40 hex digits), `<word>` (a letter or digit, then letters, digits, `_.-`), `<url>` (a `https://github.com/` URL), `<file>` (a path with no pattern or `~` characters and not under `/dev/`, inside the working checkout or a temp or scratch root, that passes the usual read check), or `<text>` (any one argument, only as a whole word). Profiles hold no regular expressions.
- No argument the shell would expand: an unquoted `*`, `?` or `[`, or a leading `~`. Quote a literal pattern (`--reason '*'`).
- No environment prefix, wrapper (`env`, `command`), input redirect, standard input or pipe into it.

The default-branch check trusts the local remote-tracking refs, so the engine refuses local writes that could move them or what they show: `git update-ref` on anything but a plain `refs/heads/*` or `refs/tags/*` name that is not a symbolic ref (so not `refs/remotes/*`, `refs/replace/*` or `HEAD`), `update-ref --stdin` or `--no-deref`, `symbolic-ref` with a name or target under `refs/remotes/`, a fetch from `.`, a path or a `file:` URL, a fetch whose refspec writes `refs/remotes/<remote>/<branch>` from anything but that branch of that configured remote, `--refmap`, and a push to `.` or a local path. (`remotes/<r>/<b>` counts as `refs/remotes/<r>/<b>`.) To keep the origin honest it also refuses `git remote add`, `set-url`, `rename`, `set-branches`, `remove` and `set-head`; `git config` writes outside a short list of safe keys, which covers `remote.*`, `url.*` and `include*`; `git clone` with `-c`/`--config`, `-o`/`--origin`, `--template`, `--separate-git-dir` or `--upload-pack`; and `git init --template` or `--separate-git-dir`. Direct writes into `.git/config`, `.git/worktrees/*/config` and `config.worktree` are refused as protected paths. A normal `git fetch origin [main | +pull/N/head:prN]`, and a plain clone from the listed remote, stay approved.

**This is an audit label, not yet a security boundary.** In a worktree the engine approves `node <script>` for a script it does not list without reading it ([#48](https://github.com/agent-corpus/tools/issues/48)), so an agent could run an unlisted script that reads the same secret. Until #48 lands, a helper approval records which listed helper ran; it does not stop an unlisted one.

Every other command in the same script is judged as usual. A script with a listed file name that fails any check (changed, untracked, outside a checkout, a symlink, other arguments) goes to a person as a credential read. A listed helper counts as creating no symlink, so a later temp write in the same script stays approvable. An entry's path must be repository-relative with `/` separators and no `.` or `..` segments; the list holds at most 20 helpers of 50 shapes each, and an invalid entry makes the profile invalid (strict).

#### MCP read-only tools

`mcpReadOnly` lists MCP tools that run without a prompt, in any `mode`. Each entry is an exact `mcp__<server>__<tool>` name, or a name whose tool segment ends in `*` (`mcp__docs__search_*`). Neither segment may contain `__`, and a wildcard approves only a tool whose whole tool segment (after `mcp__<server>__`) is free of `__`, so it cannot reach another server such as `github__get`. Whole-server wildcards (`mcp__github__*`), regular expressions and other tool names are rejected, and the list holds at most 200 entries of 128 characters. List only tools that cannot change anything and cannot return credentials: the tool name is all the engine checks, not the arguments. Prefer exact names. A prefix also covers tools that a server adds later, and read-looking prefixes can include secret readers: the GitHub server's `get_*` and `list_*` cover its secret-scanning alert tools, which return the detected secret.

The server segment is whatever name the harness configuration gives the server, and the engine cannot tell where it came from. In Claude Code, a project `.mcp.json` server overrides a user server of the same name, so a repository can register its own `github`. Once the user enables it, its listed tools run without a prompt. List only servers defined in managed or user configuration, and pair the list with the harness's MCP server allowlists (Claude Code `enabledMcpjsonServers`, or managed MCP settings).

A listed tool is approved. Any other MCP tool gets no decision from the policy manager: the harness's own permission flow (allow rules, prompts) handles it exactly as without the hook, so nothing that worked before needs a classification or a new prompt. The audit log records an MCP request with the tool name and argument keys hashed, never argument values.

| Harness     | MCP support                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | `PreToolUse` matcher `mcp__.*` (regex on `mcp__<server>__<tool>`); `PermissionRequest` already sees every tool.                                                                                                          |
| Codex       | Same matcher; Codex names MCP tools `mcp__<server>__<tool>` in `PreToolUse` and `PermissionRequest`. The new matcher changes the `PreToolUse` hook's trust hash, so trust it again in `/hooks` after `setup-hook-codex`. |
| Copilot     | Not supported. The Copilot hooks reference documents no MCP tool name for hooks, so setup adds no MCP matcher and `mcpReadOnly` never matches a Copilot tool; Copilot's own MCP permissions apply.                       |

Measure a profile against real usage with `policy-manager replay ~/.claude/projects --profile policy.json`: it replays the Bash commands recorded in Claude Code transcripts through the evaluator (nothing is executed) and prints the approval rate with and without the profile, plus the most common reasons that still need a human. Reports include short command excerpts, so keep them local.

Protected names (`.claude`, `.agent-config`, `AGENTS.md`, ...) are judged relative to the repository root, so a linked worktree under `<repo>/.claude/worktrees/<name>` is ordinary code while `<worktree>/.claude/settings.json` stays protected. `git config` is limited to a short allowlist of local, non-executable keys; hooks, aliases, credential helpers, URLs and `--global` always need a human. For `--session`, a single shell command's scope comes from every word that could name a file it touches: non-option arguments, `--option=value` and `-oVALUE` values, and redirect targets (`>`, `>>`, `<`), so `printf x >> .agent-config/README.md` and `tee -a .agent-config/a` are covered like a patch, while a command that also names `AGENTS.md` or `.claude` is not. A variable assigned a single-quoted literal that is not one plain word (`Q='query($t: ID!)'`) is known only inside double quotes, so `gh api graphql -f query="$Q"` is judged on its value; an unquoted `$Q` stays unknown. Read-only cloud verbs (`list`, `show`, `describe`, `get-*`) and `az boards query` (a WIQL read) are approved beyond the exact catalog unless the arguments name credentials or override the endpoint.

`git worktree remove --force <path>` is approved when `<path>` is a linked worktree of the repository (listed by `git worktree list`, never the main worktree), resolves strictly inside a `scratchRoots` entry or the system temp directory, lies outside the main checkout, and holds no other worktree; exactly one `-f`/`--force` may be given (a second one also removes a locked worktree), and not after a command that can create symlinks. A worktree under the main checkout (`.worktrees/x`) still needs a human. `git worktree prune` with only `-n`/`-v` is approved: it drops records of worktrees whose directories are already gone.

#### Recoverable deletions and resets

Deletion that Git can undo is approved; anything Git cannot restore still goes to a human. The evidence is read from Git at decision time and never cached. All of these require a linked worktree on a feature branch (not `main`, `master` or `origin/HEAD`'s branch) and a script that contains only these commands plus `cd`, `pwd`, `echo`, `ls` and `true`, with no redirections, assignments, wrappers, variables or substitutions, since an earlier command could change the files first (`mv untracked tracked; rm tracked`).

- **`rm`** with only `-f`, `-r`, `-R`, `-d`, `-v` before the operands, when every operand exists, is tracked, and has nothing under it that is untracked, ignored, modified, staged, assume-unchanged, skip-worktree or a submodule. Globs, `~`, `.`/`..` segments, backslashes and a leading `-`, `:` or `=` (zsh expands `=name` to a command's path; `./=name` is fine) stay human. Parent symlinks are resolved; a final symlink is the link itself unless a trailing slash follows it. Protected and credential paths stay human, as category `sensitive`, never classified.
- **Files this session created.** `rm`/`rm -f` (not `-r`) of an untracked file is approved when this session created that exact path: a Write or patch, a `>`/`>>` redirect, `touch`, `tee` or `cp` to a path that did not exist, or that is still exactly the session's file. `mv` and a patch's `Move to:` keep the source's content, so they count only when the source was the session's. After the tool runs (`PostToolUse`), the file there is recorded only if it is the session's own inode (edited, or moved there by the session) or a new inode whose birth time is no older than the approval. A rename keeps the birth time, so `mv notes.md x && touch x` does not make a user's file the session's. A new inode still says nothing about its content (`gzip notes.md`, `git stash pop`), so a shell script records creations only when every simple command in it is provably on an allowlist. The allowed commands are `touch`, `tee [-a]`, `cp`/`mv` from a file the session owns when the hook runs, and inert commands (`echo`, `printf`, `pwd`, `ls`, `true`), each with any `>`/`>>` redirect. A `cd` (or `pushd`, `popd`, `chdir`) anywhere makes the script record nothing, since a skipped `true || cd sub` cannot be told from the text. A bare name or a system bin path counts; a relative path does not. Ownership never chains through earlier commands in the same script. A command substitution, process substitution, heredoc or here-string, input or descriptor redirect (`<`, `>&`), path word the shell would expand or resolve differently (leading `~` or `=`; a `$`, glob, brace or backslash anywhere; a `.` or `..` segment, which the kernel resolves from a symlink's target), assignment, variable, wrapper (`env`, `xargs`, `time`, `nice`, `command`), nested shell, unknown option, or anything unparsable makes the whole script record nothing. Where the platform reports no birth time, nothing new is recorded. The session stores the file's device, inode, size and mtime under a hash of its path. A later symlink, hard link, edit by anything else, or `git checkout` over it no longer matches. This is held in the session's memory only, never shared or cached across sessions. Any other untracked file or directory goes to the classifier.
- **`cd <dir> && ...`.** When the rest of an `&&` chain follows a lone `cd`, later commands are judged only in the new directory, since they run only if the `cd` succeeded. With `;` or a later `||`, both directories are judged.
- **`git rm`** without `--force` is approved as before (Git itself refuses to drop changes). `git rm -f` needs the `rm` evidence, except that a file already deleted from the working tree is fine.
- **`git reset --hard [<commit>]`** (with at most `-q`) when no tracked change is uncommitted, every commit it drops from the branch is on a remote-tracking ref, no untracked or ignored file sits where the target writes, and the target changes no protected path.
- **`git checkout -- <paths>`, `git checkout .` and `git restore [-W] <paths>`** when the working tree already matches the index for those paths, or the files are only missing. `git restore -SW` needs the working tree and index to match `HEAD`. A tree-ish, `--source`, `-p` or `-f` stays human.

An `rm` whose operands are all plain paths inside a linked feature worktree, but which the evidence above cannot prove recoverable (another untracked file, a directory), is not approved by the engine and goes to the AI classifier (step 2 of **How a request is decided**) like any other escalation, which approves it on `recoverable: true` at 0.95. `git clean`, forced pushes and refspecs, unmerged branch deletion and forced worktree removal are hard human items and are never classified.

Deleting a branch is automatic only when it is already merged into `origin/main` (or `master`): reachable from it, or patch-equivalent to a squash or rebase merge. Remote deletion also needs `origin` and a `git ls-remote` tip that matches the fetched tracking ref, so unfetched commits block it. Evidence uses the locally fetched default branch; fetch first for very recent merges.

## Service, cache, and logs

The service uses a Unix socket on macOS/Linux and a named pipe on Windows. A random session token authenticates local requests. Files use owner-only modes on Unix. On Windows, the operating system's temporary-directory ACL is the access boundary; Unix modes do not establish Windows ACL isolation. Other processes running as the same user are outside this boundary.

The cache belongs to the service process and is scoped to harness plus session ID. It holds at most 512 cloud-inspection decisions, expires entries after one minute, and evaluates policy before lookup. Filesystem and branch evidence is never cached. `SessionEnd` or `policy-manager stop <harness> <session-id>` stops the service. An idle service stops after 30 minutes. Requests restart it when necessary; crash-created stale sockets require inspection rather than unsafe automatic deletion.

`SessionStart` reports the private temporary directory containing `audit.jsonl`. Each request and decision is recorded before an approval is returned. The log stores versioned event envelopes, readable action summaries, opaque session identifiers, request hashes, and hashed targets. It excludes paths, argument values, source text, credentials, and model explanations. Compare request hashes against the original request in the harness transcript during an investigation. Logs rotate at 10 MiB per segment and stop accepting writes at 100 MiB total. Earlier segments remain available through `audit-log query` and `audit-log export`; no records are automatically deleted. Logs remain after normal shutdown and can disappear during operating-system cleanup. Copy them before cleanup when needed.

Logging failure, malformed requests, service failure, and unknown semantics never produce an automatic approval. Permission hooks fall through to native human handling. Pre-tool failures exit 2. Host timeout behavior differs: Copilot command-hook timeouts fall through to its normal permission flow. Codex does not support `ask` in `PreToolUse`: it parses the value, marks the hook failed and runs the tool anyway. A decision that needs a human is therefore returned to Codex as a `deny` whose reason says the command was not run and that approving it in chat does not unblock it (the decision is deterministic, so a retry is denied again); there is no in-Codex button to approve it. The reason gives the `approve` command the user runs in their own terminal (see **Approving from the terminal**). An ambiguous request is the other way through: its reason points to the session policy-manager agent, and a classification of approved is accepted for the session, so a retry passes. Codex also rejects `PreToolUse` `permissionDecision: "allow"` without `updatedInput` ("PreToolUse hook returned unsupported permissionDecision:allow", checked against Codex CLI 0.167.2), so an approval there is no decision: empty output and exit 0. If Codex would still prompt, its `PermissionRequest` hook returns `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`, which suppresses the prompt; a request that needs a human gets no output there and Codex's own prompt.

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
