# Live trackers

## Goal

Serve the approved React interface on loopback port 17999. Collect issue plans,
PR evidence, and task reports independently. Persist state between sessions.

## Dependency boundary

These packages are foundational tools. They do not depend on a consuming organization's
repositories, agent instructions, private issue conventions, or domain model.

The public [tracking plan contract](tracking-plan-v1.md) is owned by `tracker-core`.
The board accepts this normalized data without requiring a GitHub issue: register a local JSON file
with `project-watch add plan.json`. The built-in GitHub reader is an optional source integration
for issues that explicitly embed this public contract.

A consumer owns its source formats and mapping into this contract. A consumer-specific adapter
can read its issues, apply its conventions, and write a validated JSON plan for the tools to observe.
It can instead adopt the public contract directly. The tools never load the consumer's instructions
to interpret its private format, and do not infer a plan from arbitrary issue prose.

The consumer also decides which work requires approval and what evidence proves completion.
The tools display supplied facts and derive dependency readiness; they do not establish an
organization's approval or completion policy. The conservative `pending` default represents
unspecified approval, not a requirement that every organization use the same approval workflow.

Dependency direction:

```text
Consumer domain, issue conventions, agents, and policy
                         |
               consumer-owned mapping
                         |
              public tracking contract
                         |
       generic collectors, state, CLI, and board
```

A new consumer must be able to use the tools without accessing another consumer's repository.
Examples and test fixtures therefore use neutral projects. Domain-specific agents and adapters
belong in the consuming organization's repositories.

## Contract

Tracking issues contain exactly one fenced `tracking-plan` JSON block. Version 1
contains id, name, description, units, and decisions. Units have stable IDs,
status, dependencies, explicit approval and evidence links. Reject duplicate IDs,
unknown dependencies, cycles, unknown versions, and malformed data.

The source plan owns intent. PR observations own GitHub facts. Task reports own
reported activity, with expiry. Readiness never implies approval or completion.

## Components

tracker-core: validated contracts, atomic state transactions, CLI conventions.
issue-watch: issue body, labels and comments; change events with persisted baseline.
task-report: start/update/finish reports with expiry and evidence URLs.
project-watch: register local plans or GitHub issues, refresh, brief, event stream.
live-board: local HTTP service, authenticated mutations, SSE and React assets.

## Validation

Exercise invalid plans, dependency cycles, concurrent state transactions, expired
heartbeats, stale observations, HTTP origin checks, durable changes and browser UI.
Test on Windows, macOS and Linux in CI. No cloud deployment is needed.

## Run from this checkout

Use Node.js 20.19+ or 22.12+ and npm. Windows, macOS, and Linux use the same commands.
Run these commands from the tools repository:

```text
npm install
npm run build
node packages/project-watch/dist/cli.js add https://github.com/OWNER/REPO/issues/123
node packages/live-board/dist/cli.js serve --port 17999
```

Open the printed URL. `http://localhost:17999` also works.
The server binds only to IPv4 loopback. It continues collecting without an agent session or browser tab.
Keep its terminal open. Ctrl+C stops the server; restart the same command to resume the workspace.
Use `--port` if the port is occupied. This release does not install an OS service.

After the packages are published, install a chosen release of `@agent-corpus/live-board` and
`@agent-corpus/project-watch`. Their binaries are `live-board` and `project-watch`.
Publication is a separate release step; the checkout commands work before publication.

The board is named **Orbit**. This is a product name, not a framework. It uses React and Vite.
The runtime server uses Node's HTTP library. The UI has no remote asset dependency.
Text is at least 16px, with 18px body text and larger headings. Desktop and mobile layouts adapt independently.

## Connect sources

GitHub credentials stay on the server. Authentication uses `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`.
Read access to each issue and linked PR is enough. The collectors never write to GitHub.
Public repositories work without credentials but have lower API limits.
GitHub.com is the supported remote provider in version 1. Enterprise hosts need a future adapter.

Read [the tracking plan contract](tracking-plan-v1.md), then validate and register a source:

```text
node packages/project-watch/dist/cli.js validate --file issue-body.md
node packages/project-watch/dist/cli.js add ./plan.json
node packages/project-watch/dist/cli.js status
node packages/project-watch/dist/cli.js remove PROJECT_ID
```

The browser accepts GitHub issue URLs. Register local files through the CLI.
Local files can hold plain JSON or Markdown with the fenced contract.
Keep them at a stable absolute location; registration resolves relative paths immediately.
A removed project leaves its source unchanged. Historical events remain in the local activity log.
The issue body owns the plan. Comments contribute to issue revisions but never override plan intent.
Prose-only tracking issues show an actionable format error until they are migrated deliberately.

## Generic tools

| Tool            | Purpose                                                               | Example                                |
| --------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `issue-watch`   | Observe issue body, labels, state, and comments                       | `issue-watch watch ISSUE_URL --follow` |
| `task-report`   | Publish task claims with expiring heartbeats                          | `task-report put --file report.json`   |
| `project-watch` | Register sources, validate plans, derive readiness and record changes | `project-watch events --follow`        |
| `live-board`    | Serve the React UI and stream live state                              | `live-board serve --port 17999`        |
| `tracker-core`  | Library for schema validation and atomic state transactions           | `parsePlan(body)`                      |
| `pr-watch`      | Existing PR observer, unchanged                                       | `pr-watch status PR_URL`               |

All CLIs expose `usage` and `usage --json`. Results use JSON; continuous output uses NDJSON.
Exit 0 means the command succeeded; exit 1 means command failure. A valid workspace response may contain source errors.
`project-watch watch` emits one refreshed snapshot. Add `--follow` for continuous output.
`issue-watch watch` waits for a change against its persisted baseline, emitting the first observation if no baseline exists.
`project-watch events --since ISO_TIMESTAMP --follow` filters its durable event history.
A separate terminal or agent can read these streams without adding model calls to each poll.

## Agent reporting

```json
{
  "id": "planner-session",
  "project": "PROJECT_ID_FROM_STATUS",
  "unit": "planner",
  "agent": "Implementation session",
  "status": "running",
  "message": "Implementing the approved planner scope.",
  "evidence": [],
  "ttlSeconds": 300
}
```

Use the registered project ID, not the plan's descriptive ID. Report IDs are unique within a project.
Send the same report ID again to renew its heartbeat. `running` reports expire after `ttlSeconds`.
Terminal states are `blocked`, `done`, and `failed`; they remain dated claims.
A report never marks a plan unit complete. Completion remains a deliberate source-plan update.
An organization-specific agent can publish reports through this CLI. Its instructions and execution policy live outside these tools.

## State, refresh, and recovery

State defaults to `~/.agent-corpus/trackers`. Every CLI accepts `--home PATH`; `TRACKER_HOME` also sets it.
Use the same directory for the server, project commands, and task reports.
Separate directories create independent workspaces. Multiple browser tabs can share one server.
Prefer one continuous collector per workspace to avoid redundant GitHub requests.

Snapshots and events persist in `workspace.json`; task claims persist in `tasks.json`.
Each JSON update uses a directory lock and atomic rename. Concurrent writers cannot interleave a file write.
If a writer crashes while holding a lock, stop all writers and remove the named `.lock` directory.
The error identifies the exact lock. The next command resumes from the last committed JSON state.
Invalid JSON state fails visibly rather than being silently overwritten.
Use a local disk, not a network filesystem, for reliable locking semantics.

The default poll interval is 60 seconds; `--interval` accepts seconds, minimum 5.
A source becomes stale after three minutes without a successful observation.
Intervals longer than three minutes will therefore intentionally show stale state between observations.
The server keeps the last valid plan on an error. PR errors retain the prior observation with a visible warning.
GitHub rate-limit responses pause further GitHub collection until the indicated retry time.
Other transient errors retry on the next poll. Each HTTP request has a 30-second timeout.
A slow source can delay the sequential collection pass; the browser and cached API remain responsive.

The event history retains the latest 1,000 changes. It is a local progress log, not an audit archive.
`project-watch seen` updates the shared “while you were away” cursor for this workspace.
SSE reconnects send a full snapshot, so a dropped browser connection does not lose current state.

## Local API

- `GET /api/state`: current board projection.
- `GET /api/events`: server-sent state snapshots.
- `GET /api/session`: per-process mutation token for the local browser.
- `POST /api/projects`, `/api/remove`, `/api/refresh`, `/api/seen`, `/api/tasks`: local mutations.

POST requests require `X-Tracker-Token`. Origin and Host checks reject foreign browser origins and DNS rebinding hosts.
No CORS access is granted. Source strings and report text render as text, not HTML.
The token protects browser requests; it does not isolate other processes running as the same local user.
Files contain source text and task messages, so use an appropriate local workspace and do not include secrets or sensitive personal data.
No credentials are saved in state or sent to the browser.

## Development checks

Run `npm run verify` for lint, compilation, types, and unit/integration tests.
Run `npx playwright install chromium`, then `npm run test:browser --workspace @agent-corpus/live-board`.
The browser test creates isolated local plans and exercises live updates, source failure recovery, dialogs, and mobile layout.
It also checks rendered text size, contrast, horizontal overflow, and runtime errors.
CI runs the suite on Linux, Windows, and macOS. The browser check runs on Linux.
