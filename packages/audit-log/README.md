# @agent-corpus/audit-log

Structured audit events for tools and coding harnesses. The library and CLI share private JSONL storage, request correlation, redaction, query, export, and bounded rotation. There are no runtime dependencies.

## Library API

```ts
import { AuditLog } from "@agent-corpus/audit-log";

const log = new AuditLog("/private/session-audit");
const receipt = log.append({
  eventName: "permission.request",
  source: "policy-manager",
  sessionId: "opaque-session-id",
  requestId: "opaque-request-id",
  summary: "az resource list",
  attributes: { category: "cloud-read", targetHash: "opaque-target-hash" },
});
const page = await log.query({ requestId: receipt.requestId, limit: 100 });
for await (const line of log.export({ sessionId: receipt.sessionId })) {
  process.stdout.write(line);
}
```

`append` returns the stored, redacted record after the file is flushed with `fsync`. An error means the caller has no successful receipt; a partially completed write can still exist. Permission tools must defer approval when append fails. Other consumers decide their own failure policy.

`query` returns at most 1000 records by default, with `nextCursor` when more matches remain. Resume with `after: nextCursor` and the same filters. Limits range from 1 through 10000. `export` streams every matching record unless a limit is explicitly supplied. Time filters use inclusive ISO UTC timestamps. An unknown cursor or invalid record fails visibly.

## CLI

```sh
audit-log usage --json
audit-log append /private/session-audit < event.json
audit-log query /private/session-audit --request-id opaque-request-id --limit 100
audit-log export /private/session-audit --session-id opaque-session-id > investigation.jsonl
```

Append reads one JSON event on stdin. Query writes a JSON page. Export writes JSONL and respects stdout backpressure. Diagnostics omit input data and use stderr. Exit codes: 0 success, 1 invalid input or storage failure, 2 busy storage.

## Record schema

Each line contains `schemaVersion: 1`, a generated `eventId`, UTC `timestamp` and `observedTimestamp`, `eventName`, `source`, opaque `sessionId`, optional `requestId`, `severityText`, optional redacted `summary`, and structured `attributes`.

The timestamp, observed timestamp, event name, severity, and attributes map to the corresponding [OpenTelemetry log fields](https://opentelemetry.io/docs/specs/otel/logs/data-model/). This JSONL envelope is not the OTLP wire format. Domain events remain producer-owned. The policy manager records request, classification, decision, human-response, and execution-result events using one request correlation value. Distinct event IDs identify repeated observations. Sources are producer declarations, not proof of human identity or permission grants.

## Privacy and storage

Use fixed action names and opaque correlation IDs. Sensitive attribute keys are replaced with `[REDACTED]`, including credentials, tokens, raw commands, paths, prompts, source contents, and stdout/stderr. Common credential patterns in text are also redacted, and control characters are sanitized. Arbitrary free text can still contain sensitive data without a recognizable pattern. Producers must build safe summaries and avoid submitting raw payloads.

Directories and regular files must belong to the current user and use owner-only Unix permissions. Symbolic links and hard-linked log files are rejected. Windows uses the user's temporary-directory ACL; Unix file modes do not establish Windows ACL isolation. Other same-user processes and administrators remain outside this access boundary. Local files are append-only through this API, not immutable forensic storage.

The active file is `audit.jsonl`. Rotation preserves earlier records in ordered `audit.00000001.jsonl` segments. Defaults are 10 MiB per segment and 100 MiB total. Configure `maxFileBytes`/`maxTotalBytes` in the library or `--max-file-bytes`/`--max-total-bytes` in the CLI. Reaching capacity fails without deleting records. Retention is explicit: export records to a durable location and let the operator manage their retention. Temporary-directory cleanup remains under operating-system control.

An exclusive `audit.lock` serializes writers and captures consistent read snapshots. Concurrent callers receive `AuditBusyError` and can retry. A crash can leave a lock or incomplete record; the tool preserves both for inspection and refuses automatic repair. Queries include rotated segments. Legacy unversioned logs require an explicit migration outside this API.

The library and CLI are the initial API. An authenticated local service can be added when multiple tools require a shared resident writer. Network collection and remote retention are separate integrations.
