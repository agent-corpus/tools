# Contributing

Thanks for helping! This repo is a monorepo of small TypeScript tools; see the
[README](README.md) for the layout.

## Setup

```sh
git clone https://github.com/agent-corpus/tools.git
cd tools
npm install
npm run verify
```

Node.js 20+ is required (`.nvmrc` pins the development version).

## Workflow

`main` is protected: all changes go through a pull request with passing CI (squash-merged).

1. Create a branch and make your change, with tests.
2. Run `npm run verify` — this is exactly what CI runs.
3. If the change affects a published package's behaviour, add a changeset:
   `npm run changeset`. Pick the package(s), the bump (patch / minor / major) and write a
   one-line, user-facing summary. Docs-only and internal changes need no changeset.
4. Open a pull request. Keep it focused; describe the why.

## Releasing (maintainers)

Publishing is automated; you never run `npm publish` by hand.

1. Contributors add a changeset to their PRs (`npm run changeset`).
2. To ship, open a release PR from a branch:

   ```sh
   npm run version-packages   # bumps versions + changelogs; consumes the changesets
   npm install                # refresh the lockfile
   ```

   If the changelog step complains about GitHub access, run it with
   `GITHUB_TOKEN=$(gh auth token)`.
3. Merge the release PR. The Release workflow publishes every package whose version is not yet on
   npm (npm trusted publishing, with provenance) and pushes the `@agent-corpus/<name>@<version>` tag.
   Merges that don't change a version publish nothing ("No unpublished projects to publish").

First-publish and trusted-publisher setup, and the branch rules, are in
[docs/releasing.md](docs/releasing.md).

## Conventions

- TypeScript, strict mode, ESM (`NodeNext`). Import local files with a `.js` extension.
- Formatting and linting are handled by Biome (`npm run lint:fix`).
- Prefer the Node standard library over new dependencies. A new runtime dependency needs a reason.
- CLIs write machine-readable results to **stdout** and diagnostics to **stderr**, and document
  their exit codes.
- Every CLI ships a `usage` command for agents. If you add behaviour, update that text and the
  package README.
- Test the logic as pure functions where possible; use injected clients/clocks rather than the
  network or real timers.

## Adding a new tool

See [docs/adding-a-package.md](docs/adding-a-package.md).

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.

## Code of conduct

Be kind and constructive. Harassment or personal attacks are not tolerated; maintainers may
remove comments or contributors that violate this.
