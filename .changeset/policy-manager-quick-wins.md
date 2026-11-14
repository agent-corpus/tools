---
"@agent-corpus/policy-manager": minor
---

Permissive profile: approve `grep`/`rg` glob-valued options (`--include=*.md`, `-g*.ts`), `az boards query`, `git worktree remove --force` of a linked worktree in a temp or scratch directory, plain `git worktree prune`, and `cp`/`ln` out of a main checkout into the temp directory (sources are reads; `chmod` modes are not paths). Security: bare credential file operands (`cat id_rsa`, `grep x secrets.json`, `head server.pem`, `cat *`) are now resolved against the working directory and sent to a person (#33); `credentials.*`/`secrets.*` data files (json, yaml, toml, ini, env, ...) count as credential paths.
