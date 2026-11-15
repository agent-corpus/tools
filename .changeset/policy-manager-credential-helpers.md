---
"@agent-corpus/policy-manager": minor
---

Add `credentialHelpers` to the profile: listed scripts that read a credential for one narrow job, such as posting a review as a GitHub App, run without a prompt. `node <script> <args>` is approved only when the script is the tracked file at its listed repository path, unchanged (`hash-object --no-filters`) from the default branch on `origin`, with no symlink, environment prefix, wrapper, input redirect or standard input, and its arguments match a listed shape word for word (literals, alternatives, and the placeholders `<repo>`, `<int>`, `<sha>`, `<word>`, `<url>`, `<file>`, `<text>`), with no argument the shell would expand. A `<file>` must lie in the working checkout or a temp or scratch root. The audit record names the helper. A script with a helper's file name that fails any check goes to a person. A listed helper counts as creating no symlink, so a later temp write in the same script stays approvable.

Local writes that move remote-tracking refs now go to a person: `update-ref`/`symbolic-ref` on `refs/remotes/*`, `update-ref --stdin`, a fetch from `.`, a path or a `file:` URL, a fetch refspec that writes `refs/remotes/<remote>/<branch>` from anything but that branch of that configured remote, `--refmap`, and a push to `.` or a local path.

Until `node <unlisted script>` in a worktree is checked (#48), a helper approval is an audit label, not a security boundary.

The `--session` scope for a protected file now reads "writes to <file>"; a directory stays "writes under <dir>".
