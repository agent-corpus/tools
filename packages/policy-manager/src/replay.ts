import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyWithCli } from "./classifier.js";
import { evaluate } from "./policy.js";
import { type Profile, strictProfile } from "./profile.js";
import { PolicySession, type SessionDependencies } from "./session.js";
import type { Request } from "./types.js";

export interface ReplayReport {
  commands: number;
  approved: number;
  strictApproved: number;
  /** Escalations the AI classifier handles instead of a person (permissive profile only). */
  classified: number;
  reasons: Array<{ reason: string; count: number; examples: string[] }>;
}

function transcriptFiles(paths: string[], limit: number): string[] {
  const files: Array<[string, number]> = [];
  const visit = (path: string) => {
    const stat = statSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (path.endsWith(".jsonl")) files.push([path, stat.mtimeMs]);
  };
  for (const path of paths) visit(path);
  return files
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path]) => path);
}

/**
 * Replays the Bash commands recorded in Claude Code transcripts (`~/.claude/projects/**.jsonl`)
 * through the evaluator and reports the approval rate with and without a profile. Commands are
 * not executed. Output lists reasons and a first-line excerpt of examples, so keep reports local.
 */
export function replayTranscripts(paths: string[], profile: Profile, files = 50): ReplayReport {
  const seen = new Set<string>();
  const reasons = new Map<string, { count: number; examples: string[] }>();
  const report: ReplayReport = {
    commands: 0,
    approved: 0,
    strictApproved: 0,
    classified: 0,
    reasons: [],
  };
  for (const file of transcriptFiles(paths, files))
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"tool_use"')) continue;
      let entry: { cwd?: string; message?: { content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content as Array<{ type?: string; name?: string; input?: unknown }>) {
        const command = (item.input as { command?: unknown } | undefined)?.command;
        if (item.type !== "tool_use" || item.name !== "Bash" || typeof command !== "string")
          continue;
        const cwd = entry.cwd ?? process.cwd();
        const key = `${cwd}\0${command}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const request: Request = {
          sessionId: "replay",
          harness: "claude",
          cwd,
          tool: "Bash",
          input: { command },
        };
        const decision = evaluate(request, undefined, profile);
        report.commands++;
        if (evaluate(request, undefined, strictProfile).decision === "approve")
          report.strictApproved++;
        if (decision.decision === "approve") {
          report.approved++;
          continue;
        }
        if (decision.tier === "ambiguous") report.classified++;
        const bucket = reasons.get(decision.reason) ?? { count: 0, examples: [] };
        bucket.count++;
        if (bucket.examples.length < 3)
          bucket.examples.push(command.split("\n")[0]?.slice(0, 100) ?? "");
        reasons.set(decision.reason, bucket);
      }
    }
  report.reasons = [...reasons]
    .map(([reason, value]) => ({ reason, ...value }))
    .sort((a, b) => b.count - a.count);
  return report;
}

export interface ClassifiedReplay {
  /** Unique commands read, newest first, until `limit` escalations were found. */
  commands: number;
  engineApproved: number;
  escalations: number;
  aiApproved: number;
  userAllowApproved: number;
  /** Left to the harness by the user's own deny or ask rule. */
  userRuleNative: number;
  /** Other decisions that leave the request to the harness (unlisted MCP tools and the like). */
  otherNative: number;
  stillAsk: number;
  askReasons: Array<{ reason: string; count: number; examples: string[] }>;
  classifierRuns: number;
  classifierErrors: Record<string, number>;
  latencyMs: { p50: number; p95: number; max: number };
}

interface Candidate {
  cwd: string;
  command: string;
  /** Files the transcript wrote with a file tool before this command. */
  created: string[];
}

/** Bash commands of the newest transcripts, newest first, each with what its session wrote before. */
function candidates(paths: string[], files: number): Candidate[] {
  const all: Candidate[] = [];
  for (const file of transcriptFiles(paths, files)) {
    const created: string[] = [];
    const found: Candidate[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"tool_use"')) continue;
      let entry: { cwd?: string; message?: { content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content as Array<{ type?: string; name?: string; input?: unknown }>) {
        if (item.type !== "tool_use") continue;
        const input = (item.input ?? {}) as { command?: unknown; file_path?: unknown };
        if (item.name === "Write" && typeof input.file_path === "string") {
          created.push(input.file_path);
          if (created.length > 200) created.shift();
        }
        if (item.name === "Bash" && typeof input.command === "string")
          found.push({
            cwd: entry.cwd ?? process.cwd(),
            command: input.command,
            created: [...created],
          });
      }
    }
    all.push(...found.reverse());
  }
  return all;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length
    ? (sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number)
    : 0;

/**
 * Replays the newest `limit` escalations through the full hook decision: the engine, then the
 * real AI classifier (the harness's own CLI, `concurrency` at a time), then the user's own
 * permission rules. Each escalation gets a fresh session in a private temporary directory, seeded
 * with the files its transcript wrote before it. Nothing is executed and no settings are changed.
 */
export async function replayClassified(
  paths: string[],
  profile: Profile,
  options: {
    limit?: number;
    files?: number;
    concurrency?: number;
    harness?: Request["harness"];
    deps?: SessionDependencies;
  } = {},
): Promise<ClassifiedReplay> {
  const limit = options.limit ?? 300;
  const harness = options.harness ?? "claude";
  const report: ClassifiedReplay = {
    commands: 0,
    engineApproved: 0,
    escalations: 0,
    aiApproved: 0,
    userAllowApproved: 0,
    userRuleNative: 0,
    otherNative: 0,
    stillAsk: 0,
    askReasons: [],
    classifierRuns: 0,
    classifierErrors: {},
    latencyMs: { p50: 0, p95: 0, max: 0 },
  };
  const seen = new Set<string>();
  const escalations: Candidate[] = [];
  for (const candidate of candidates(paths, options.files ?? 200)) {
    if (escalations.length >= limit) break;
    const key = `${candidate.cwd}\0${candidate.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    report.commands++;
    const request: Request = {
      sessionId: "replay",
      harness,
      cwd: candidate.cwd,
      tool: "Bash",
      input: { command: candidate.command },
    };
    if (evaluate(request, undefined, profile).decision === "approve") report.engineApproved++;
    else escalations.push(candidate);
  }
  report.escalations = escalations.length;
  const latencies: number[] = [];
  const base = options.deps?.classify;
  const classify: NonNullable<SessionDependencies["classify"]> = async (cli, prompt, p) => {
    const outcome = await (base ?? ((c, t, q) => classifyWithCli(c, t, q.classifier)))(
      cli,
      prompt,
      p,
    );
    report.classifierRuns++;
    latencies.push(outcome.latencyMs);
    if (!outcome.ok)
      report.classifierErrors[outcome.reason] = (report.classifierErrors[outcome.reason] ?? 0) + 1;
    return outcome;
  };
  const reasons = new Map<string, { count: number; examples: string[] }>();
  const root = mkdtempSync(join(tmpdir(), "acp-replay-"));
  try {
    let next = 0;
    const worker = async () => {
      while (next < escalations.length) {
        const index = next++;
        const candidate = escalations[index] as Candidate;
        const directory = join(root, String(index));
        mkdirSync(directory, { mode: 0o700 });
        const session = new PolicySession(directory, harness, "replay", profile, undefined, {
          classify,
          ...(options.deps?.nativeRules ? { nativeRules: options.deps.nativeRules } : {}),
        });
        for (const path of candidate.created) session.noteCreated(path);
        const decision = await session.decide(
          {
            sessionId: "replay",
            harness,
            cwd: candidate.cwd,
            tool: "Bash",
            input: { command: candidate.command },
          },
          "PreToolUse",
        );
        if (decision.decision === "approve") {
          if (decision.userAllowRule) report.userAllowApproved++;
          else if (decision.classification === "approved") report.aiApproved++;
          else report.engineApproved++;
        } else if (decision.decision === "native") {
          if (decision.userRule) report.userRuleNative++;
          else report.otherNative++;
        } else {
          report.stillAsk++;
          const reason = decision.hard
            ? `hard: ${decision.hard}`
            : decision.ai
              ? `classifier: ${decision.ai.category}, recoverable ${decision.ai.recoverable}, confidence ${decision.ai.confidence < 0.95 ? "< 0.95" : ">= 0.95"}`
              : decision.fallbackReason
                ? `no classification: ${decision.fallbackReason}`
                : decision.reason;
          const bucket = reasons.get(reason) ?? { count: 0, examples: [] };
          bucket.count++;
          if (bucket.examples.length < 3)
            bucket.examples.push(candidate.command.split("\n")[0]?.slice(0, 100) ?? "");
          reasons.set(reason, bucket);
        }
      }
    };
    await Promise.all(Array.from({ length: options.concurrency ?? 4 }, worker));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  report.askReasons = [...reasons]
    .map(([reason, value]) => ({ reason, ...value }))
    .sort((a, b) => b.count - a.count);
  const sorted = latencies.sort((a, b) => a - b);
  report.latencyMs = {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? 0,
  };
  return report;
}
