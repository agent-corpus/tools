import { randomUUID } from "node:crypto";
import type { Attribute, AuditRecord, EventInput } from "./types.js";

const sensitiveKey =
  /(?:password|secret|credential|token|authorization|cookie|connectionstring|apikey|privatekey|^command$|^cmd$|^content$|^contents$|^patch$|^stdout$|^stderr$|^prompt$|^body$|^raw$|^path$|^filepath$|^cwd$)/i;
function safeText(value: string): string {
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(value)) return "[REDACTED]";
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(?:password|secret|token|api[_-]?key|connection[_-]?string)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/[\s\S]/g, (char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .slice(0, 4096);
}
function attribute(value: unknown, depth: number): Attribute {
  if (depth > 8) throw new Error("Audit attributes exceed the nesting limit");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return safeText(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error("Too many audit attribute values");
    return value.map((item) => attribute(item, depth + 1));
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 128) throw new Error("Too many audit attributes");
    return Object.fromEntries(
      entries
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => {
          if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(key))
            throw new Error("Invalid audit attribute name");
          return [
            key,
            sensitiveKey.test(key.replace(/[_-]/g, "")) ? "[REDACTED]" : attribute(item, depth + 1),
          ];
        }),
    );
  }
  throw new Error("Audit attributes must contain JSON values");
}
export function timestamp(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Use an ISO UTC timestamp");
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19))
    throw new Error("Use a valid calendar timestamp");
  return normalized;
}
export function record(input: EventInput): AuditRecord {
  if (!input || typeof input !== "object") throw new Error("Expected an audit event");
  for (const value of [
    input.eventName,
    input.source,
    input.sessionId,
    ...(input.requestId === undefined ? [] : [input.requestId]),
  ]) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,127}$/.test(value))
      throw new Error("Invalid audit identifier");
  }
  if (input.severityText !== undefined && !["INFO", "WARN", "ERROR"].includes(input.severityText))
    throw new Error("Invalid severity");
  if (input.summary !== undefined && typeof input.summary !== "string")
    throw new Error("Invalid event summary");
  const observedTimestamp = new Date().toISOString();
  const attributes = attribute(input.attributes ?? {}, 0);
  if (!attributes || Array.isArray(attributes) || typeof attributes !== "object")
    throw new Error("Audit attributes must be an object");
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    timestamp: input.timestamp === undefined ? observedTimestamp : timestamp(input.timestamp),
    observedTimestamp,
    eventName: input.eventName,
    source: input.source,
    sessionId: input.sessionId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    severityText: input.severityText ?? "INFO",
    ...(input.summary === undefined ? {} : { summary: safeText(input.summary) }),
    attributes,
  };
}
export function parseRecord(line: string): AuditRecord {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object") throw new Error("Invalid audit record");
  const r = value as AuditRecord;
  if (r.schemaVersion !== 1 || typeof r.eventId !== "string" || !/^[a-f0-9-]{36}$/.test(r.eventId))
    throw new Error("Invalid audit record");
  // Revalidate and redact data even when another producer changed a stored record.
  return { ...record(r), eventId: r.eventId, observedTimestamp: timestamp(r.observedTimestamp) };
}
