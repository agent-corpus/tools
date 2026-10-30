# agent-corpus/tools

[![CI](https://github.com/agent-corpus/tools/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-corpus/tools/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Small, composable developer tools for **coding agents** — written in TypeScript, published to npm
under the [`@agent-corpus`](https://www.npmjs.com/org/agent-corpus) scope.

Every tool follows the same principles:

- **Agent-agnostic.** Plain CLIs and libraries. Nothing is tied to a particular agent, IDE or model.
- **Self-describing.** Each CLI has a `usage` command that prints a guide written for an agent to
  read, plus a machine-readable `--json` manifest.
- **Machine-first output.** Structured output on stdout (NDJSON/JSON), diagnostics on stderr,
  documented exit codes.
- **Few dependencies.** Prefer the Node standard library.

## Packages

| Package                                       | Description                                                                                                                | npm                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`@agent-corpus/pr-watch`](packages/pr-watch) | Block until something actionable happens on a GitHub PR (stale branch, new review, failing CI, conflicts) and emit events. | [![npm](https://img.shields.io/npm/v/@agent-corpus/pr-watch.svg)](https://www.npmjs.com/package/@agent-corpus/pr-watch) |

## Quick look

```sh
npx @agent-corpus/pr-watch usage          # the guide an agent should read first
npx @agent-corpus/pr-watch watch https://github.com/OWNER/REPO/pull/123 --timeout 30m
```

## Repository layout

```
.
├── packages/            one directory per published package
│   └── pr-watch/
├── docs/                architecture, contributing a package, releasing, agent integration
├── .changeset/          pending release notes (Changesets)
└── .github/             CI, release workflow, issue/PR templates
```

Tooling: npm workspaces, TypeScript (ESM, `tsc`), [Vitest](https://vitest.dev),
[Biome](https://biomejs.dev), [Changesets](https://github.com/changesets/changesets).

## Development

Requires Node.js 20+.

```sh
npm install
npm run verify      # lint + build + typecheck + test (what CI runs)
npm run lint:fix    # auto-format
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/adding-a-package.md](docs/adding-a-package.md) and
[docs/releasing.md](docs/releasing.md).

## License

[MIT](LICENSE)
