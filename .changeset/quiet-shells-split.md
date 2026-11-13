---
"@agent-corpus/policy-manager": minor
---

Permissive mode now judges shell functions, `set --`, `for` loops over quoted items, `while read` over literal input, `${X%/*}`-style parameter forms and `$'...'` instead of sending them to a human. Unknown values still never become a program, option or path.
