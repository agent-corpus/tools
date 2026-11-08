# @agent-corpus/task-report

Durable agent reports with expiring heartbeats.

See [the setup and operations guide](https://github.com/agent-corpus/tools/blob/main/docs/live-trackers.md) and [the plan contract](https://github.com/agent-corpus/tools/blob/main/docs/tracking-plan-v1.md).

From a built checkout, run `node packages/task-report/dist/cli.js usage` for commands.
Use `usage --json` for a machine-readable manifest.

State defaults to `~/.agent-corpus/trackers`. Set `TRACKER_HOME` to isolate a workspace.

Results are JSON or NDJSON. Exit codes: 0 success, 1 failure.
