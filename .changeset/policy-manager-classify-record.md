---
"@agent-corpus/policy-manager": minor
---

The session approves its own classification record command deterministically, in every profile: exactly `node "<dist/cli.js>" classify <harness> <session-id> <<< '<json>'` for the current harness and session, with one single-quoted JSON object and nothing else. Any other direct invocation of a record (`node … cli.js classify` or `policy-manager classify`, also behind assignments, wrappers or keywords) goes to a person: another session, harness or CLI path, or anything added. A record nested in a quoted script (`sh -c '…'`) gets the normal decision.
