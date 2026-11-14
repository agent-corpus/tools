# @agent-corpus/policy-manager

## 0.7.0

### Minor Changes

- [#35](https://github.com/agent-corpus/tools/pull/35) [`20addf0`](https://github.com/agent-corpus/tools/commit/20addf04237b4d9036d141e624e7b8bb1fc88e2e) Thanks [@charlesprakash](https://github.com/charlesprakash)! - The session approves its own classification record command deterministically, in every profile: exactly `node "<dist/cli.js>" classify <harness> <session-id> <<< '<json>'` for the current harness and session, with one single-quoted JSON object and nothing else. Any other direct invocation of a record (`node … cli.js classify` or `policy-manager classify`, also behind assignments, wrappers or keywords) goes to a person: another session, harness or CLI path, or anything added. A record nested in a quoted script (`sh -c '…'`) gets the normal decision.

- [#37](https://github.com/agent-corpus/tools/pull/37) [`965ae78`](https://github.com/agent-corpus/tools/commit/965ae7857647251344fe4e117d2cd99282e7bf40) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Permissive profile: approve `grep`/`rg` glob-valued options (`--include=*.md`, `-g*.ts`), `az boards query`, `git worktree remove --force` of a linked worktree in a temp or scratch directory, plain `git worktree prune`, and `cp`/`ln` out of a main checkout into the temp directory (sources are reads; `chmod` modes are not paths). Security: bare credential file operands (`cat id_rsa`, `grep x secrets.json`, `head server.pem`, `cat *`) are now resolved against the working directory and sent to a person ([#33](https://github.com/agent-corpus/tools/issues/33)); `credentials.*`/`secrets.*` data files (json, yaml, toml, ini, env, ...) count as credential paths.

- [#36](https://github.com/agent-corpus/tools/pull/36) [`71fe65c`](https://github.com/agent-corpus/tools/commit/71fe65cb95af94292c000ad9f853c9749e3ec04b) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Permissive mode now resolves variables assigned in an `&&` chain of literal assignments for commands after the chain: `S=/abs && H=x; ls $S/$H` is judged as `ls /abs/x` instead of going to a human as an environment variable of unknown content. A bare uppercase assignment with no command substitution or redirection cannot fail, so the chain always reaches it. Shell-reserved names (`UID`, `SECONDS`, `BASH*`, `ZSH*`, zsh's lowercase specials), `$(...)` values, `export` and prefix assignments still leave later names unknown.

## 0.6.0

### Minor Changes

- [#32](https://github.com/agent-corpus/tools/pull/32) [`ff0df6b`](https://github.com/agent-corpus/tools/commit/ff0df6b3158bc883faa5bceb365d3e30916bfb79) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Codex no longer reports "unsupported permissionDecision:allow" on every approved tool call: an approval now sends no decision, and Codex's own prompt is approved through `PermissionRequest`. A session can now edit another repository's linked feature worktree with `cd <worktree> && ...` and create worktrees under `.worktrees/` or `.claude/worktrees/` from any clone, while writes to a main checkout still go to a person.

- [#28](https://github.com/agent-corpus/tools/pull/28) [`dbbba05`](https://github.com/agent-corpus/tools/commit/dbbba058a6859f496fec7f20cfa53cf8dad8b39d) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Profiles can list read-only MCP tools in `mcpReadOnly` (exact `mcp__<server>__<tool>` names, or a tool-name prefix ending in `*`), and those tools run without a prompt; unlisted MCP tools are left to the harness's own permission flow. `setup-hook-claude` and `setup-hook-codex` add `mcp__.*` to the `PreToolUse` matcher (Codex users re-trust the hook in `/hooks`); Copilot is not supported.

- [#29](https://github.com/agent-corpus/tools/pull/29) [`d0d341b`](https://github.com/agent-corpus/tools/commit/d0d341b738acc570cd50166a94904f6330c163ce) Thanks [@charlesprakash](https://github.com/charlesprakash)! - The permissive profile no longer prompts for deletions that can be undone or thrown away. This covers removing committed files or files the session itself created, and `git reset --hard`, `checkout --` or `restore` that discard nothing, all in a feature worktree. Other file deletions inside a feature worktree are approved only when the session classifier judges them recoverable. History, remote, cloud and publishing operations still go to a person.

- [#31](https://github.com/agent-corpus/tools/pull/31) [`922639d`](https://github.com/agent-corpus/tools/commit/922639d8cb6b3fc2eaa6b538b8e68e537e4f3ba3) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Permissive mode now judges shell functions, `set --`, `for` loops over quoted items, `while read` over literal input, `${X%/*}`-style parameter forms and `$'...'` instead of sending them to a human. Unknown values still never become a program, option or path.

- [#30](https://github.com/agent-corpus/tools/pull/30) [`b56b262`](https://github.com/agent-corpus/tools/commit/b56b2623df63b80602666eccb6b14ca21a0d904d) Thanks [@charlesprakash](https://github.com/charlesprakash)! - The permissive profile now approves writes to the system temp directory and deletions inside scratch or temp directories without asking, while policy state, repositories, and credential or protected paths stay guarded. The classification prompt reads as an instruction (`Needs classification (not an error)`), states the approval rule, and survives a retry with a different command description.

## 0.5.0

### Minor Changes

- [#24](https://github.com/agent-corpus/tools/pull/24) [`ca4b6c0`](https://github.com/agent-corpus/tools/commit/ca4b6c065a04b3f1d07d53dbdda6f09574c3b3ce) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Ambiguous requests are decided by the session's AI classifier instead of a person (experiment). Under the permissive profile, an escalation that is not a deterministic security boundary is blocked once with an instruction to classify and retry. The classification approves a recoverable, non-sensitive action or denies it with a reason; a person is asked only if the classifier is unavailable or invalid. Adds audit events and `policy-manager review-classifications` for a risk review, and `replay` reports how many escalations move to the classifier.

- [#23](https://github.com/agent-corpus/tools/pull/23) [`b7afd10`](https://github.com/agent-corpus/tools/commit/b7afd1073e49eade6f4d8d427993f51eb0b669ba) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Codex: a decision that needs a human is now enforced. Codex parses `permissionDecision: "ask"` in `PreToolUse` but does not support it (it marks the hook failed and runs the tool anyway), so the adapter previously only added context and every such command ran. It now returns a `deny` whose reason says the command was not run and that approving it in chat does not unblock it (ask the user to run it themselves or change the policy profile; an ambiguous cloud request can instead be classified by the session policy-manager agent and retried); approvals are still returned as `allow`, and Codex's own approval prompt (`PermissionRequest`) is left to Codex. Claude and Copilot output is unchanged and pinned by tests.
  
  Codex `PostToolUse` sends a Bash result as plain output text with no exit code or duration, so the audit now records `unknown` instead of `completed` when the status cannot be derived; a structured `exit_code` is used when present. The generated Codex `SessionEnd` hook uses a 3-second timeout, the maximum Codex allows. The README and `setup-hook-codex` output now explain Codex hook trust: setup never grants it, the hash covers the command and the effective timeout, trust is tied to the command text, so an upgrade at the same path keeps trust (review a new version before upgrading in place) and a changed command, such as a new install path or Node binary, requires trusting the hooks again.

## 0.4.0

### Minor Changes

- The permissive profile now understands whole shell scripts, not just chains of simple commands, and judges every command that could run. New syntax: quoted-delimiter heredocs and here-strings (`git commit -m "$(cat <<'EOF' ... EOF)"`, `cat <<'EOF' > file`), comments, line continuation, `&`, `&>`, `|&`, `<(...)`, `( ... )`, `{ ...; }`, `for`, `while`, `until`, `if`, `case`, and a literal `$` at the end of a regex.
  
  Variables: `NAME=value`, `export NAME=value` and `for NAME in a b c` give a variable a known value, and the command is judged with it substituted, in every directory and for every value it could take (so `X=rm; $X -rf y` is destructive). Variables assigned in only some branches, in a loop, or from a command, and environment variables the script did not assign (which can hold credentials), are unknown; an unknown value is accepted only as an argument to `echo`, `printf` with string conversions, `test`/`[` without numeric operators, `true`, `false`, `basename` and `dirname`, or as the value of a commit or PR message option, and never as a program, option, path, `cd` target or redirection target.
  
  Heredocs and interpreters: a shell fed by a heredoc has its body judged as a script. An interpreter fed by a heredoc, here-string or `-c` is treated like inline code: the code is scanned for file deletion, process creation, string evaluation and protected paths, which now also applies to `-c` and `-e` code that was previously not read. Code piped into an interpreter still needs a human.
  
  Tightened: `ssh` and database clients (`psql`, `mysql`, `sqlite3`, ...), `trap`, `alias`, `declare` and similar builtins, `printenv`, bare `env` and `set`, assigning `IFS`, `PS4`, `CDPATH` and similar through any route (prefix, plain assignment, `export`, `for`, `read`, `unset`, `printf -v`), a glob in a command name or option (`r[m] -rf x`), and `cd` or `export` behind `command` or `time`. Unquoted `$[`, `$=`, `$^`, `$~` and `$((`, which zsh and bash evaluate, are still rejected.

## 0.3.0

### Minor Changes

- The shell parser now understands two kinds of expansion instead of rejecting every `$`. `$HOME` and `${HOME}` are substituted, so `ls $HOME/x` is judged on its real path. Parameters whose value is unknown (`$?`, `$#`, `$$`, `PIPESTATUS`/`pipestatus` entries) are accepted like a command substitution result, so `echo "exit: ${pipestatus[1]}"` is judged on its real command but the unknown value can never become a program, option, path or redirection target. Command substitution (`$(...)` and backticks, including nested and quoted) is judged by evaluating the inner command with the same rules before the outer command; its output (and the unknown parameters above) is accepted only as an argument to `echo`, `printf`, `test`, `[`, `true`, `false`, `basename` and `dirname`, and never as a program, `cd` target, redirection target, wrapper word (such as an `env` assignment or `timeout` duration), or argument to any other command. Other variables, arithmetic expansion, `$'...'` and heredocs are still sent to a human.
  
  Security: the protected-path list now also covers `~/.config/gh`, `~/.config/gcloud`, `~/.config/op`, `~/.docker`, `~/.gnupg`, `~/.git-credentials`, `~/.password-store`, `~/.vault-token`, `~/.pgpass`, `~/.my.cnf` and `~/.pypirc`, which the permissive profile could previously read.

## 0.2.1

### Patch Changes

- Security: a quoted or escaped value in a leading assignment (`FOO="a b" rm -rf x`, `FOO=a\ b git push --force`) made the parser treat the whole `FOO=...` word as the program, so the real command after it was never checked and could be auto-approved. Leading assignments are now recognised from their plain `NAME=` prefix regardless of quotes or escapes in the value. Appended and indexed forms (`FOO+=x`, `FOO[0]=x`) and assignments with a quoted or escaped name, which the parser cannot represent, are rejected so a human reviews them, and `env` treats any `NAME…=value` word as an assignment before judging the program that follows. Present in 0.2.0 and earlier permissive-profile releases; upgrade to 0.2.1.

- [#19](https://github.com/agent-corpus/tools/pull/19) [`e3b73d3`](https://github.com/agent-corpus/tools/commit/e3b73d3147b31eaef31b845cc3384cf6c80264b3) Thanks [@charlesprakash](https://github.com/charlesprakash)! - The shell parser now accepts backslash escapes: `\.`, `\|` and `\ ` outside quotes, and `\"`, `\\`, `\$` inside double quotes. An escaped character is always literal, so an escaped `;`, `&&` or quote never splits a command or ends a string. A trailing backslash and a backslash-newline are still rejected. In replay over local transcripts this raises the permissive approval rate from 34.7% to 53.7%.

## 0.2.0

### Minor Changes

- [#15](https://github.com/agent-corpus/tools/pull/15) [`b6c7db0`](https://github.com/agent-corpus/tools/commit/b6c7db0e3d45b44169160ce8f5814b2130ae0d4a) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Permissive profile: judge protected names relative to the repository root so linked worktrees under `.claude/worktrees` are ordinary code, resolve `cd ~` and bare `cd`, approve read-only cloud verbs (`az`, `aws`, `gcloud` list/show/describe/get) outside the exact catalog, and allow a short list of non-executable local `git config` keys. Add `policy-manager replay <transcripts>` to measure the approval rate over recorded Bash commands without executing anything.

- [#14](https://github.com/agent-corpus/tools/pull/14) [`bdccaf8`](https://github.com/agent-corpus/tools/commit/bdccaf84deb30908c5531c0aef7149e627336a30) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Add an optional policy profile (`policy-manager profile install <file>`) with a `permissive` mode that approves compound shell commands and everything except destructive, credential and protected-path effects. Remote and local branch deletion is automatic only when the branch is already merged into origin's default branch, including squash merges. Human-review messages no longer imply an AI classification that was not performed.

### Patch Changes

- [#13](https://github.com/agent-corpus/tools/pull/13) [`bb20968`](https://github.com/agent-corpus/tools/commit/bb2096811b49a3ae21c56f36805b63120d018144) Thanks [@charlesprakash](https://github.com/charlesprakash)! - Resolve Windows short-path aliases before checking repository boundaries, so valid reads and linked-worktree writes receive the same decisions as on macOS and Linux.

- `SessionEnd` no longer fails when no policy service is running for the session (for example `claude update`, or a session that never started). It exits successfully, creates no session directory, and still reports unsafe-directory and other real errors.
