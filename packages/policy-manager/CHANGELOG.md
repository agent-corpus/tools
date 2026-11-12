# @agent-corpus/policy-manager

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
