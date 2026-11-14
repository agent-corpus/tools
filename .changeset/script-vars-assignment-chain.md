---
"@agent-corpus/policy-manager": minor
---

Permissive mode now resolves variables assigned in an `&&` chain of literal assignments for commands after the chain: `S=/abs && H=x; ls $S/$H` is judged as `ls /abs/x` instead of going to a human as an environment variable of unknown content. A bare uppercase assignment with no command substitution or redirection cannot fail, so the chain always reaches it. Shell-reserved names (`UID`, `SECONDS`, `BASH*`, `ZSH*`, zsh's lowercase specials), `$(...)` values, `export` and prefix assignments still leave later names unknown.
