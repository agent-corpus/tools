---
"@agent-corpus/policy-manager": minor
---

The session approves its own classification record command deterministically, in every profile: exactly `node "<dist/cli.js>" classify <harness> <session-id> <<< '<json>'` for the current harness and session, with one single-quoted JSON object and nothing else. Any other command shaped like a classification record (another session, harness or CLI path, the generic form, or anything added) goes to a person.
