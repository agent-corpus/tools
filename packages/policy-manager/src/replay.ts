import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "./policy.js";
import { type Profile, strictProfile } from "./profile.js";
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
