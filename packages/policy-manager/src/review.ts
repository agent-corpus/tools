import { existsSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, type AuditRecord } from "@agent-corpus/audit-log";

/** One ambiguous request, followed through classification to its outcome. */
export interface ClassifiedRequest {
  session: string;
  requestHash: string;
  time: string;
  command?: string;
  reason?: string;
  category?: string;
  confidence?: number;
  recoverable?: boolean;
  rationale?: string;
  /** What happened to the request: `approved`/`denied` by the AI, `human` after a fallback. */
  outcome: "approved" | "denied" | "fallback" | "unresolved";
  fallbackReason?: string;
  execution?: { status?: string; exitCode?: number };
  humanResponse?: string;
}

export interface ClassificationReview {
  sessions: number;
  requested: number;
  approved: number;
  denied: number;
  fallback: number;
  fallbackReasons: Record<string, number>;
  unresolved: number;
  /** Share of requested ambiguous requests that reached a person. */
  fallbackRate: number;
  histogram: Array<{ range: string; count: number }>;
  aiApproved: ClassifiedRequest[];
  aiDenied: ClassifiedRequest[];
  approvedButFailed: ClassifiedRequest[];
  humanDenied: ClassifiedRequest[];
}

const BUCKETS: Array<[string, number, number]> = [
  ["0.00-0.50", 0, 0.5],
  ["0.50-0.80", 0.5, 0.8],
  ["0.80-0.90", 0.8, 0.9],
  ["0.90-0.95", 0.9, 0.95],
  ["0.95-0.99", 0.95, 0.99],
  ["0.99-1.00", 0.99, 1.0001],
];

export function sessionDirectories(extra: string[] = []): string[] {
  const root = tmpdir();
  const found = existsSync(root)
    ? readdirSync(root)
        .filter((name) => /^acp-[A-Za-z0-9]+-[a-f0-9]{24}$/.test(name))
        .map((name) => join(root, name))
    : [];
  return [...found, ...extra].filter((path) => {
    try {
      return lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  });
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export async function reviewClassifications(
  directories: string[],
  since?: string,
): Promise<ClassificationReview> {
  const requests: ClassifiedRequest[] = [];
  let sessions = 0;
  for (const directory of directories) {
    const records: AuditRecord[] = [];
    try {
      let after: string | undefined;
      for (;;) {
        const page = await new AuditLog(directory).query({
          ...(since ? { since } : {}),
          ...(after ? { after } : {}),
          limit: 10000,
        });
        records.push(...page.records);
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }
    } catch {
      continue; // an unreadable or foreign directory is skipped, never trusted
    }
    if (!records.length) continue;
    sessions++;
    const byRequest = new Map<string, ClassifiedRequest>();
    const entry = (record: AuditRecord): ClassifiedRequest | undefined => {
      if (!record.requestId) return undefined;
      let value = byRequest.get(record.requestId);
      if (!value) {
        value = {
          session: record.sessionId,
          requestHash: record.requestId,
          time: record.timestamp,
          outcome: "unresolved",
        };
        byRequest.set(record.requestId, value);
      }
      return value;
    };
    for (const record of records) {
      const a = record.attributes;
      // Only requests that entered the classification flow are reviewed.
      if (record.eventName !== "classification-requested" && !byRequest.has(record.requestId ?? ""))
        continue;
      if (record.eventName === "classification-requested") {
        const value = entry(record);
        if (!value) continue;
        value.time = record.timestamp;
        const command = text(a.redactedCommand);
        if (command) value.command = command;
        const reason = text(a.reason);
        if (reason) value.reason = reason;
        if (!requests.includes(value)) requests.push(value);
      } else if (record.eventName === "classification") {
        const value = entry(record);
        if (!value) continue;
        const category = text(a.category);
        if (category) value.category = category;
        const confidence = num(a.confidence);
        if (confidence !== undefined) value.confidence = confidence;
        if (typeof a.recoverable === "boolean") value.recoverable = a.recoverable;
        const rationale = text(a.rationale);
        if (rationale) value.rationale = rationale;
      } else if (record.eventName === "decision") {
        const value = entry(record);
        if (!value) continue;
        if (a.classification === "approved") value.outcome = "approved";
        else if (a.classification === "denied") value.outcome = "denied";
        else if (a.classification === "fallback") value.outcome = "fallback";
      } else if (record.eventName === "classification-fallback") {
        const value = entry(record);
        if (!value) continue;
        value.outcome = "fallback";
        const reason = text(a.fallbackReason);
        if (reason) value.fallbackReason = reason;
      } else if (record.eventName === "execution-result") {
        const value = entry(record);
        if (!value) continue;
        value.execution = {
          ...(text(a.status) ? { status: text(a.status) as string } : {}),
          ...(num(a.exitCode) !== undefined ? { exitCode: num(a.exitCode) as number } : {}),
        };
      } else if (record.eventName === "human-response") {
        const value = entry(record);
        if (value) value.humanResponse = text(a.response) ?? "";
      }
    }
  }
  const approved = requests.filter((r) => r.outcome === "approved");
  const denied = requests.filter((r) => r.outcome === "denied");
  const fallback = requests.filter((r) => r.outcome === "fallback");
  const fallbackReasons: Record<string, number> = {};
  for (const r of fallback) {
    const key = r.fallbackReason ?? "unavailable";
    fallbackReasons[key] = (fallbackReasons[key] ?? 0) + 1;
  }
  return {
    sessions,
    requested: requests.length,
    approved: approved.length,
    denied: denied.length,
    fallback: fallback.length,
    fallbackReasons,
    unresolved: requests.length - approved.length - denied.length - fallback.length,
    fallbackRate: requests.length ? fallback.length / requests.length : 0,
    histogram: BUCKETS.map(([range, low, high]) => ({
      range,
      count: requests.filter(
        (r) => r.confidence !== undefined && r.confidence >= low && r.confidence < high,
      ).length,
    })),
    aiApproved: approved,
    aiDenied: denied,
    approvedButFailed: approved.filter(
      (r) =>
        r.execution &&
        (r.execution.status === "failed" ||
          (r.execution.exitCode !== undefined && r.execution.exitCode !== 0)),
    ),
    humanDenied: requests.filter((r) => r.humanResponse === "denied"),
  };
}

function row(r: ClassifiedRequest): string {
  const outcome = r.execution
    ? ` -> ${r.execution.status ?? "ran"}${r.execution.exitCode !== undefined ? ` (exit ${r.execution.exitCode})` : ""}`
    : "";
  return `  ${r.time}  ${r.category ?? "?"} ${r.confidence ?? "?"} recoverable=${r.recoverable ?? "?"}\n    ${r.command ?? r.requestHash}${outcome}${r.rationale ? `\n    why: ${r.rationale}` : ""}`;
}

export function formatReview(review: ClassificationReview): string {
  const pct = (n: number) => `${((100 * n) / Math.max(review.requested, 1)).toFixed(1)}%`;
  const lines = [
    `Sessions scanned: ${review.sessions}`,
    `Ambiguous requests sent to classification: ${review.requested}`,
    `  AI approved:        ${review.approved} (${pct(review.approved)})`,
    `  AI denied:          ${review.denied} (${pct(review.denied)})`,
    `  Fell back to human: ${review.fallback} (${pct(review.fallback)})${Object.entries(
      review.fallbackReasons,
    )
      .map(([k, v]) => ` ${k}=${v}`)
      .join("")}`,
    `  Never resolved:     ${review.unresolved} (${pct(review.unresolved)}; the model abandoned the command)`,
    "",
    "Confidence histogram (classifier self-report):",
    ...review.histogram.map((b) => `  ${b.range}  ${b.count}`),
    "",
    `AI-approved commands that failed (${review.approvedButFailed.length}):`,
    ...review.approvedButFailed.map(row),
    "",
    `Commands a person later denied (${review.humanDenied.length}):`,
    ...review.humanDenied.map(row),
    "",
    `All AI-approved commands (${review.aiApproved.length}):`,
    ...review.aiApproved.map(row),
    "",
    `AI-denied commands (${review.aiDenied.length}):`,
    ...review.aiDenied.map(row),
  ];
  return lines.join("\n");
}
