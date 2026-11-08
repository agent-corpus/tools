import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const link = z
  .string()
  .url()
  .refine((v) => ["https:", "http:"].includes(new URL(v).protocol));
export const unitSchema = z
  .object({
    id: identifier,
    title: z.string().min(1),
    status: z.enum(["planned", "active", "blocked", "done", "paused"]),
    dependsOn: z.array(identifier).default([]),
    approval: z.enum(["pending", "approved", "not-required"]).default("pending"),
    approvalEvidence: link.optional(),
    evidence: z.array(link).default([]),
    prs: z
      .array(z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/))
      .default([]),
    outcome: z.string().default(""),
    verification: z.string().default(""),
  })
  .strict()
  .refine(
    (u) => u.approval !== "approved" || !!u.approvalEvidence,
    "Approved scope requires approvalEvidence",
  );
export const planSchema = z
  .object({
    version: z.literal(1),
    id: identifier,
    name: z.string().min(1),
    description: z.string().default(""),
    units: z.array(unitSchema),
    decisions: z
      .array(
        z
          .object({
            id: identifier,
            title: z.string().min(1),
            state: z.enum(["open", "resolved"]),
            detail: z.string().default(""),
            source: link.optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = new Set(p.units.map((u) => u.id));
    if (ids.size !== p.units.length)
      ctx.addIssue({ code: "custom", message: "Duplicate unit IDs" });
    if (new Set(p.decisions.map((d) => d.id)).size !== p.decisions.length)
      ctx.addIssue({ code: "custom", message: "Duplicate decision IDs" });
    const visiting = new Set<string>(),
      visited = new Set<string>();
    function visit(id: string): void {
      if (visiting.has(id)) {
        ctx.addIssue({ code: "custom", message: "Dependency cycle" });
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of p.units.find((u) => u.id === id)?.dependsOn ?? []) {
        if (!ids.has(dep)) ctx.addIssue({ code: "custom", message: `Unknown dependency ${dep}` });
        else visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
    }
    for (const id of ids) visit(id);
  });
export type Plan = z.infer<typeof planSchema>;
export function parsePlan(body: string): Plan {
  const blocks: string[] = [];
  let lines: string[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    const fence = line.trimEnd();
    if (lines) {
      if (fence === "```") {
        blocks.push(lines.join("\n"));
        lines = undefined;
      } else lines.push(line);
    } else if (fence === "```tracking-plan") lines = [];
  }
  if (lines || blocks.length !== 1)
    throw new Error("Expected exactly one complete tracking-plan block");
  return planSchema.parse(JSON.parse(blocks[0] ?? ""));
}
export const dataDir = () =>
  resolve(process.env.TRACKER_HOME || join(homedir(), ".agent-corpus", "trackers"));
export async function readState<T>(name: string, fallback: T, dir = dataDir()): Promise<T> {
  try {
    return JSON.parse(await readFile(join(dir, name), "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}
export async function transact<T>(
  name: string,
  fallback: T,
  update: (v: T) => T,
  dir = dataDir(),
): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, `${name}.lock`);
  let acquired = false;
  for (let i = 0; i < 100; i++) {
    try {
      await mkdir(lock);
      acquired = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await sleep(50);
    }
  }
  if (!acquired)
    throw new Error(
      `State is locked: ${lock}. If its writer crashed, remove this lock directory after stopping all writers.`,
    );
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    const next = update(await readState(name, fallback, dir));
    await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temp, join(dir, name));
    return next;
  } finally {
    await rm(temp, { force: true });
    await rm(lock, { recursive: true });
  }
}
export function args() {
  return parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      follow: { type: "boolean" },
      home: { type: "string" },
      interval: { type: "string" },
      port: { type: "string" },
      file: { type: "string" },
      since: { type: "string" },
    },
  });
}
export function output(v: unknown) {
  process.stdout.write(`${JSON.stringify(v)}\n`);
}
export function usage(name: string, commands: string[]) {
  const manifest = {
    name,
    commands,
    environment: ["TRACKER_HOME", "GITHUB_TOKEN", "GH_TOKEN"],
    exitCodes: { 0: "success", 1: "failure" },
    format: "JSON; follow emits NDJSON",
  };
  if (process.argv.includes("--json")) output(manifest);
  else
    process.stdout.write(
      `# ${name}\n\n${commands.map((c) => `- ${name} ${c}`).join("\n")}\n\nUse --home PATH to isolate state (default: ~/.agent-corpus/trackers).\nAuthenticate GitHub with GITHUB_TOKEN, GH_TOKEN, or gh auth login.\nResults are JSON; --follow emits NDJSON. Exit codes: 0 success, 1 failure.\n`,
    );
}
export async function main(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
export function interval(value: string | undefined) {
  const n = Number(value ?? 60);
  if (!Number.isFinite(n) || n < 5) throw new Error("interval must be at least 5 seconds");
  return n * 1000;
}
