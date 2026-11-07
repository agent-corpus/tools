#!/usr/bin/env node
import { once } from "node:events";
import { parseArgs } from "node:util";
import { AuditBusyError, AuditLog } from "./index.js";
import type { EventInput, Filters } from "./types.js";

const usage = `audit-log usage [--json]
audit-log append <directory>                     # one event JSON object on stdin
audit-log query <directory> [filters]            # {records,nextCursor} JSON
audit-log export <directory> [filters]           # JSONL on stdout
Filters: --session-id, --request-id, --event-name, --source, --since, --until, --after, --limit
Storage: --max-file-bytes (default 10485760), --max-total-bytes (default 104857600)
Append creates private files and fsyncs before returning the redacted record.
Queries default to 1000 records and return a resume cursor. Export includes all matches unless --limit is set.
Rotated segments stay in the chosen directory. Capacity exhaustion fails; no records are automatically deleted.
Exit codes: 0 success, 1 invalid input or storage failure, 2 log busy (retry).
`;
async function input(): Promise<EventInput> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Event too large");
  }
  return JSON.parse(text) as EventInput;
}
try {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "usage")
    console.log(args.includes("--json") ? JSON.stringify({ usage }) : usage);
  else {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: Object.fromEntries(
        [
          "session-id",
          "request-id",
          "event-name",
          "source",
          "since",
          "until",
          "after",
          "limit",
          "max-file-bytes",
          "max-total-bytes",
        ].map((key) => [key, { type: "string" as const }]),
      ),
    });
    const [command, directory] = positionals;
    if (
      !directory ||
      positionals.length !== 2 ||
      !["append", "query", "export"].includes(command ?? "")
    )
      throw new Error("Invalid command");
    const number = (name: string) =>
      values[name] === undefined ? undefined : Number(values[name]);
    const log = new AuditLog(directory, {
      maxFileBytes: number("max-file-bytes"),
      maxTotalBytes: number("max-total-bytes"),
    });
    const filters: Filters = {
      sessionId: values["session-id"],
      requestId: values["request-id"],
      eventName: values["event-name"],
      source: values.source,
      since: values.since,
      until: values.until,
      after: values.after,
      limit: number("limit"),
    };
    if (command === "append") console.log(JSON.stringify(log.append(await input())));
    else if (command === "query") console.log(JSON.stringify(await log.query(filters)));
    else
      for await (const line of log.export(filters))
        if (!process.stdout.write(line)) await once(process.stdout, "drain");
  }
} catch (error) {
  console.error(
    error instanceof AuditBusyError
      ? "Audit log is busy; retry after the current operation."
      : "Audit operation failed. Check the event, filters, private storage permissions, and capacity.",
  );
  process.exitCode = error instanceof AuditBusyError ? 2 : 1;
}
