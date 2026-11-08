# @agent-corpus/tracker-core

Versioned tracking-plan validation and atomic local state.

See [the setup and operations guide](https://github.com/agent-corpus/tools/blob/main/docs/live-trackers.md) and [the plan contract](https://github.com/agent-corpus/tools/blob/main/docs/tracking-plan-v1.md).

Library exports include `planSchema`, `parsePlan`, `readState`, and `transact`.

State defaults to `~/.agent-corpus/trackers`. Set `TRACKER_HOME` to isolate a workspace.

Validation fails on unsupported versions, unknown fields, dependency cycles, or unsupported approval values.
