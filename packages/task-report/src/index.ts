import { identifier, link, readState, transact } from "@agent-corpus/tracker-core";
import { z } from "zod";
export const reportSchema = z
  .object({
    id: identifier,
    project: identifier,
    unit: identifier,
    agent: z.string().min(1),
    status: z.enum(["running", "blocked", "done", "failed"]),
    message: z.string(),
    evidence: z.array(link).default([]),
    ttlSeconds: z.number().int().min(30).max(86400).default(300),
  })
  .strict();
export type Report = z.infer<typeof reportSchema> & { observedAt: string };
export async function report(input: unknown) {
  const r = { ...reportSchema.parse(input), observedAt: new Date().toISOString() };
  await transact<Record<string, Report>>("tasks.json", {}, (s) => ({
    ...s,
    [`${r.project}:${r.id}`]: r,
  }));
  return r;
}
export async function reports() {
  const now = Date.now();
  return Object.values(await readState<Record<string, Report>>("tasks.json", {})).map((r) => ({
    ...r,
    stale: r.status === "running" && now - Date.parse(r.observedAt) > r.ttlSeconds * 1000,
  }));
}
