# Architecture

## Monorepo

- **npm workspaces** (`packages/*`) — no extra package manager required.
- **TypeScript**, ESM only, compiled with `tsc` to `dist/`. Shared compiler options live in
  `tsconfig.base.json`; each package has `tsconfig.json` (typecheck, includes tests) and
  `tsconfig.build.json` (emit, `src` only).
- **Vitest** for tests, **Biome** for lint + format.
- **Changesets** for versioning, changelogs and npm publishing. Packages version independently.

## Design principles for tools

1. **Agent-agnostic.** The interface is a process: arguments in; JSON lines out; exit code.
2. **Discoverable.** `<tool> usage` prints markdown written for an agent; `usage --json` prints a
   manifest (commands, events, exit codes, env).
3. **Deterministic core, thin shell.** Logic is pure functions over plain data; I/O (HTTP, clock,
   filesystem) is injected so tests need no network and no real time.
4. **Stdout is data, stderr is chatter.**

## pr-watch

```
 GitHub REST API
       │  (GithubClient: auth, pagination, rate-limit → GithubError)
       ▼
 takeSnapshot()  ──►  Snapshot  (PR state, behindBy, checks, reviews, comments)
                         │
   previous Snapshot ──► diffSnapshots()  ──►  PrEvent[]   (pure)
        ▲                                         │
        │                                         ▼
   state file (optional)          watch() loop: poll → diff → emit → exit or sleep
                                                  │
                                           CLI (main.ts): flags, NDJSON, exit codes
```

- **Snapshot/diff model.** Events are derived by comparing consecutive snapshots rather than by
  consuming a webhook/event stream. This needs no server, works behind firewalls, and makes
  "what happened while I was away" answerable by persisting one snapshot (`--state-file`).
- **Baseline.** The first snapshot reports only conditions that already hold (stale, conflicts,
  failing checks, terminal state), flagged `initial: true`. History is not replayed.
- **Blocking by default.** `watch` exits after the first batch of events so an agent can treat it as
  "wait until something needs me". `--follow` streams instead.
- **Cost.** ~8 REST requests per poll. Conditional requests/ETags and GraphQL are possible future
  optimisations.

## Public API stability

The CLI contract (event types, field names, exit codes) is the public API and follows semver.
The library exports from `index.ts` are provided for embedding but are considered less stable
before 1.0.
