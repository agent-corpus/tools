---
"@agent-corpus/policy-manager": patch
---

The shell parser now accepts backslash escapes: `\.`, `\|` and `\ ` outside quotes, and `\"`, `\\`, `\$` inside double quotes. An escaped character is always literal, so an escaped `;`, `&&` or quote never splits a command or ends a string. A trailing backslash and a backslash-newline are still rejected. In replay over local transcripts this raises the permissive approval rate from 34.7% to 53.7%.
