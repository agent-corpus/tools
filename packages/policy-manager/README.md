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

Run `policy-manager review codex session-example`. The response includes `decision` (`approve`, `human`, `deny`, or `native` for an unlisted MCP tool left to the harness), `category`, `reason`, `requestHash`, `cache`, and `cached`. The library exports the same evaluator.

The session's policy-manager agent returns the following object for an ambiguous request. The working agent submits it through `policy-manager classify codex session-example`:

```json
{ "requestHash": "<exact hash from review>", "category": "unknown", "confidence": 0.4 }
```

Categories are `code-read`, `worktree-write`, `temp-write` (a recoverable write outside any repository), `cloud-read`, `git-read`, `impactful-write`, `destructive`, `sensitive`, and `unknown`. The threshold is 0.99 plus deterministic verification and category agreement. Explicitly listed metadata operations with permitted selectors can qualify through AI classification. Endpoint overrides and cloud writes cannot qualify. Unknown commands stay human decisions. No classifier starts a second harness or calls an external model API.

## AI classification of ambiguous requests (experiment)

The rule, exported as `HUMAN_REVIEW_PRINCIPLE` and included in every classification hint: _A human prompt is reserved for high-value, high-impact actions: unrecoverable data loss, credential/secret retrieval, protected config/paths, and profile humanPatterns. Recoverable or disposable effects, including destructive-but-safe ones, are automatic._

Under a `permissive` profile, a person is asked only for what code says must stay with a person. Every other escalation is _ambiguous_: the deterministic engine cannot decide it, so the session's AI decides it instead of the person. Strict mode, and calls made outside the hooks (`policy-manager review`), are unchanged.

How a hook call flows (Claude Code, Codex and Copilot `PreToolUse`):

1. **First call.** The command is _not run_ and the person is not asked. The hook blocks it with a reason that tells the model to ask the session's policy-manager agent whether the exact command is recoverable and non-sensitive, to record the answer with `policy-manager classify`, and to retry the same command. The reason starts with `Needs classification (not an error)` and states the rule the classifier applies (`HUMAN_REVIEW_PRINCIPLE`). A person is needed only for unrecoverable loss, credential or secret retrieval, protected configuration or paths, and `humanPatterns`. A recoverable outward-facing write such as an issue comment is approvable, and so is a destructive-but-safe deletion inside a feature worktree. The request hash covers only effect-relevant input, so a retry with a different Bash `description` reuses the classification.
2. **Recorded.** The session approves the record command in that reason deterministically, in every profile: exactly `node "<this package's dist/cli.js>" classify <harness> <session-id> <<< '<json>'` for the current harness and session, with one single-quoted JSON object and nothing else in the command. Any other command shaped like a classification record (another session, harness or CLI path, the generic `policy-manager classify` form, or anything added before or after) goes to a person.
3. **Classified.** `classify` takes `{requestHash, category, confidence, recoverable, rationale}`. The request is approved only when `recoverable` is `true`, `confidence` is at least 0.95, and the category is not `sensitive` or `unknown`. A `destructive` label approves only a deletion the engine itself identified inside a linked feature worktree, on the same terms. Any other request the AI labels `destructive` (an unparsable `rm -rf ~/{a,b}`, for example), and any such deletion not judged recoverable, goes to a **person** (under Codex, a deny), since it may lose data for good. No other deterministic `destructive` escalation is classified. Anything else is a **deny with a reason** the model sees and works around. The outcome is remembered for five minutes for that exact request, and a verdict is final in that time: a deny cannot be reclassified into an approve.
4. **Fallback.** If the classifier is unavailable or its answer is invalid, the retry reaches a person through the normal prompt (under Codex, which cannot ask, it is a deny that tells the model to have the user run the command themselves or change the profile). This happens at most once per request, so there is never a loop and never a lost prompt. After 50 AI approvals in a session, further ambiguous requests go to a person.

**What always stays with a person, in code, and is never AI-relaxable** (these are the owner's calls; they list exactly what this experiment does not change):

- Credential and secret retrieval, protected paths and configuration such as the policy profile and hook settings (category `sensitive`).
- Destructive operations: unmerged-work loss, history and remote rewrites, cloud deletion, publishing, and deletion outside a linked feature worktree. Recoverable deletion is approved deterministically (see **Recoverable deletions and resets**). The only destructive escalation the classifier decides is an `rm` inside a linked feature worktree that the evidence cannot prove recoverable.
- Commands matching the profile's `humanPatterns`.
- Writes outside a linked feature worktree (main clones and protected branches).
- Cloud operations outside the read catalog. The profile's `cloudWrites: "allow"` is the way to automate these.
- Requests the engine cannot trust: incomplete or invalid requests, a different execution directory, unrecognized patches, and environment or loader overrides such as `LD_PRELOAD`.

**Known weakness.** The classifier is the working model's own policy-manager agent, and the working model records its answer, so a model that wanted to approve itself could. Confidence is self-reported. This is why the experiment records everything and is reviewed after two days of use rather than trusted.

**Recording.** The audit log gets `classification-requested` (with the command, redacted: secret-looking values, URL credentials and long tokens are replaced and the text is capped), `classification` (category, confidence, recoverable, redacted rationale), `decision` (with the stage `requested`, `approved`, `denied` or `fallback`), and `classification-fallback` (with the reason `unavailable`, `invalid-result` or `limit`). Review them across sessions:

```sh
policy-manager review-classifications [--since 2026-11-12T00:00:00Z] [--json]
```

The report shows how many ambiguous requests were approved, denied, fell back to a person (and why), and never resolved; a confidence histogram; every AI-approved command with its outcome; approved commands that then failed; and commands a person later denied. It reads the session logs under the temporary directory, which the operating system clears after a few days, so run it within two days of starting. `replay` prints how many escalations in recorded transcripts would go to the classifier instead of a person.

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

Credential-path checks skip words that are text, not paths: a `sed` script (but not the files its `r`, `w` or `e` commands name, nor `-f`), a `grep` or `rg` pattern, and `gh` `--body`, `--title`, `--jq`, `--template` and `--notes` values. Other programs keep the conservative check.

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
- **Still sent to a human:** brace expansion (`{a,b}`, `{1..3}`; `{}` and `@{u}` are literal), arithmetic (`$((`, `$[`, `(( ))`), arrays, other parameter forms (`${X:=y}`, `${!X}`, `${X/a/b}`), `function name` definitions, unquoted heredocs whose body expands, and scripts that expand to more than a few hundred commands. `cloudWrites: "allow"` also approves non-destructive cloud changes.

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

Protected names (`.claude`, `.agent-config`, `AGENTS.md`, ...) are judged relative to the repository root, so a linked worktree under `<repo>/.claude/worktrees/<name>` is ordinary code while `<worktree>/.claude/settings.json` stays protected. `git config` is limited to a short allowlist of local, non-executable keys; hooks, aliases, credential helpers, URLs and `--global` always need a human. Read-only cloud verbs (`list`, `show`, `describe`, `get-*`) are approved beyond the exact catalog unless the arguments name credentials or override the endpoint.

#### Recoverable deletions and resets

Deletion that Git can undo is approved; anything Git cannot restore still goes to a human. The evidence is read from Git at decision time and never cached. All of these require a linked worktree on a feature branch (not `main`, `master` or `origin/HEAD`'s branch) and a script that contains only these commands plus `cd`, `pwd`, `echo`, `ls` and `true`, with no redirections, assignments, wrappers, variables or substitutions, since an earlier command could change the files first (`mv untracked tracked; rm tracked`).

- **`rm`** with only `-f`, `-r`, `-R`, `-d`, `-v` before the operands, when every operand exists, is tracked, and has nothing under it that is untracked, ignored, modified, staged, assume-unchanged, skip-worktree or a submodule. Globs, `~`, `.`/`..` segments, backslashes and a leading `-`, `:` or `=` (zsh expands `=name` to a command's path; `./=name` is fine) stay human. Parent symlinks are resolved; a final symlink is the link itself unless a trailing slash follows it. Protected and credential paths stay human, as category `sensitive`, never classified.
- **Files this session created.** `rm`/`rm -f` (not `-r`) of an untracked file is approved when this session created that exact path: a Write or patch, a `>`/`>>` redirect, `touch`, `tee` or `cp` to a path that did not exist, or that is still exactly the session's file. `mv` and a patch's `Move to:` keep the source's content, so they count only when the source was the session's. After the tool runs (`PostToolUse`), the file there is recorded only if it is the session's own inode (edited, or moved there by the session) or a new inode whose birth time is no older than the approval. A rename keeps the birth time, so `mv notes.md x && touch x` does not make a user's file the session's. A new inode still says nothing about its content (`gzip notes.md`, `git stash pop`), so a shell script records creations only when every simple command in it is provably on an allowlist. The allowed commands are `touch`, `tee [-a]`, `cp`/`mv` from a file the session owns when the hook runs, and inert commands (`echo`, `printf`, `pwd`, `ls`, `true`), each with any `>`/`>>` redirect. A `cd` (or `pushd`, `popd`, `chdir`) anywhere makes the script record nothing, since a skipped `true || cd sub` cannot be told from the text. A bare name or a system bin path counts; a relative path does not. Ownership never chains through earlier commands in the same script. A command substitution, process substitution, heredoc or here-string, input or descriptor redirect (`<`, `>&`), path word the shell would expand or resolve differently (leading `~` or `=`; a `$`, glob, brace or backslash anywhere; a `.` or `..` segment, which the kernel resolves from a symlink's target), assignment, variable, wrapper (`env`, `xargs`, `time`, `nice`, `command`), nested shell, unknown option, or anything unparsable makes the whole script record nothing. Where the platform reports no birth time, nothing new is recorded. The session stores the file's device, inode, size and mtime under a hash of its path. A later symlink, hard link, edit by anything else, or `git checkout` over it no longer matches. This is held in the session's memory only, never shared or cached across sessions. Any other untracked file or directory goes to the classifier.
- **`cd <dir> && ...`.** When the rest of an `&&` chain follows a lone `cd`, later commands are judged only in the new directory, since they run only if the `cd` succeeded. With `;` or a later `||`, both directories are judged.
- **`git rm`** without `--force` is approved as before (Git itself refuses to drop changes). `git rm -f` needs the `rm` evidence, except that a file already deleted from the working tree is fine.
- **`git reset --hard [<commit>]`** (with at most `-q`) when no tracked change is uncommitted, every commit it drops from the branch is on a remote-tracking ref, no untracked or ignored file sits where the target writes, and the target changes no protected path.
- **`git checkout -- <paths>`, `git checkout .` and `git restore [-W] <paths>`** when the working tree already matches the index for those paths, or the files are only missing. `git restore -SW` needs the working tree and index to match `HEAD`. A tree-ish, `--source`, `-p` or `-f` stays human.

An `rm` whose operands are all plain paths inside a linked feature worktree, but which the evidence above cannot prove recoverable (another untracked file, a directory), goes to the session classifier. This holds only when such deletions are the script's whole effect. The script may also hold `pwd`, `echo`, `ls` and `true`, and at most a leading `cd <dir>` joined by `&&` alone. It may not contain redirections, assignments, variables or substitutions. Otherwise one verdict on the `rm` would carry later commands nobody judged, so the script goes to a person. It is approved on `recoverable: true` at 0.95, and otherwise goes to a person. Every other destructive escalation goes to a person and is never classified: `git clean`, forced pushes and refspecs, unmerged branch deletion, stash and reflog destruction, `find -delete`, `xargs rm`, `unlink`, `sudo`, cloud and infrastructure deletion, publishing, destructive HTTP verbs, and anything in the main checkout or outside a worktree.

Deleting a branch is automatic only when it is already merged into `origin/main` (or `master`): reachable from it, or patch-equivalent to a squash or rebase merge. Remote deletion also needs `origin` and a `git ls-remote` tip that matches the fetched tracking ref, so unfetched commits block it. Evidence uses the locally fetched default branch; fetch first for very recent merges.

## Service, cache, and logs

The service uses a Unix socket on macOS/Linux and a named pipe on Windows. A random session token authenticates local requests. Files use owner-only modes on Unix. On Windows, the operating system's temporary-directory ACL is the access boundary; Unix modes do not establish Windows ACL isolation. Other processes running as the same user are outside this boundary.

The cache belongs to the service process and is scoped to harness plus session ID. It holds at most 512 cloud-inspection decisions, expires entries after one minute, and evaluates policy before lookup. Filesystem and branch evidence is never cached. `SessionEnd` or `policy-manager stop <harness> <session-id>` stops the service. An idle service stops after 30 minutes. Requests restart it when necessary; crash-created stale sockets require inspection rather than unsafe automatic deletion.

`SessionStart` reports the private temporary directory containing `audit.jsonl`. Each request and decision is recorded before an approval is returned. The log stores versioned event envelopes, readable action summaries, opaque session identifiers, request hashes, and hashed targets. It excludes paths, argument values, source text, credentials, and model explanations. Compare request hashes against the original request in the harness transcript during an investigation. Logs rotate at 10 MiB per segment and stop accepting writes at 100 MiB total. Earlier segments remain available through `audit-log query` and `audit-log export`; no records are automatically deleted. Logs remain after normal shutdown and can disappear during operating-system cleanup. Copy them before cleanup when needed.

Logging failure, malformed requests, service failure, and unknown semantics never produce an automatic approval. Permission hooks fall through to native human handling. Pre-tool failures exit 2. Host timeout behavior differs: Copilot command-hook timeouts fall through to its normal permission flow. Codex does not support `ask` in `PreToolUse`: it parses the value, marks the hook failed and runs the tool anyway. A decision that needs a human is therefore returned to Codex as a `deny` whose reason says the command was not run and that approving it in chat does not unblock it (the decision is deterministic, so a retry is denied again); there is no in-Codex button to approve it. The user runs the command themselves or changes the policy profile. An ambiguous cloud request is the one exception: its reason points to the session policy-manager agent, and a classification of approved is accepted for the session, so a retry passes. Codex also rejects `PreToolUse` `permissionDecision: "allow"` without `updatedInput` ("PreToolUse hook returned unsupported permissionDecision:allow", checked against Codex CLI 0.167.2), so an approval there is no decision: empty output and exit 0. If Codex would still prompt, its `PermissionRequest` hook returns `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`, which suppresses the prompt; a request that needs a human gets no output there and Codex's own prompt.

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
