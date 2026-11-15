---
"@agent-corpus/policy-manager": minor
---

Add `credentialHelpers` to the profile: listed scripts that read a credential for one narrow job, such as posting a review as a GitHub App, run without a prompt. `node <script> <args>` is approved only when the script is the tracked file at its listed repository path, unchanged from the default branch on `origin`, with no symlink, environment prefix, wrapper or input, and its arguments match a listed shape word for word (literals, alternatives, and the placeholders `<repo>`, `<int>`, `<sha>`, `<word>`, `<url>`, `<file>`, `<text>`). The audit record names the helper. A script with a helper's file name that fails any check goes to a person. A listed helper counts as creating no symlink, so a later temp write in the same script stays approvable. The `--session` scope for a protected file now reads "writes to <file>"; a directory stays "writes under <dir>".
