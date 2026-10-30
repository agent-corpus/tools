# Adding a package

1. Create `packages/<name>/` with:
   - `package.json` — copy `packages/pr-watch/package.json` and change `name`
     (`@agent-corpus/<name>`), `description`, `bin`, `repository.directory`, `homepage`.
     Start at version `0.1.0`. Keep `"publishConfig": {"access": "public"}`.
   - `tsconfig.json` and `tsconfig.build.json` — copy from `pr-watch`.
   - `src/`, `test/`, `README.md`.
2. Include the standard scripts: `build`, `clean`, `typecheck`, `test`, `prepack`, `postpack`
   (the latter two copy the root `LICENSE` into the tarball).
3. If it is a CLI, ship a `usage` command (markdown for agents) and `usage --json`; write results
   to stdout, diagnostics to stderr; document exit codes.
4. `npm install` at the repo root to link the workspace, then `npm run verify`.
5. Add a row to the package table in the root README.
6. Add a changeset (`npm run changeset`). The first release of a new package is published by the
   release workflow when the "Version Packages" PR merges — or, for a brand-new package at its
   initial version, directly on the next push to `main`.

## Naming

- npm: `@agent-corpus/<short-name>`; binary name equals the short name.
- Keep names descriptive of the job (`pr-watch`, not `watcher`).
