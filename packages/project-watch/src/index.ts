import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { issueRef, observeIssue } from "@agent-corpus/issue-watch";
import {
  GithubClient,
  GithubError,
  parsePrRef,
  resolveToken,
  type Snapshot,
  takeSnapshot,
} from "@agent-corpus/pr-watch";
import { reports } from "@agent-corpus/task-report";
import { type Plan, parsePlan, planSchema, readState, transact } from "@agent-corpus/tracker-core";
export interface Project {
  id: string;
  source: string;
  kind: "issue" | "file";
  name: string;
  plan?: Plan;
  revision?: string;
  observedAt?: string;
  error?: string;
  prs: Record<string, Snapshot>;
  prErrors: Record<string, string>;
}
export interface Event {
  id: string;
  project: string;
  title: string;
  at: string;
  source: string;
}
export interface Workspace {
  projects: Project[];
  events: Event[];
  seenAt: string | null;
}
const empty: Workspace = { projects: [], events: [], seenAt: null };
export const state = () => readState("workspace.json", empty);
export async function register(source: string) {
  const kind: Project["kind"] = source.startsWith("https:") ? "issue" : "file";
  if (kind === "issue") {
    const ref = issueRef(source);
    source = `https://github.com/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}/issues/${ref.number}`;
  } else source = resolve(source);
  const id = createHash("sha256").update(source).digest("hex").slice(0, 16);
  await transact("workspace.json", empty, (s) => ({
    ...s,
    projects: s.projects.some((p) => p.id === id)
      ? s.projects
      : [...s.projects, { id, source, kind, name: source, prs: {}, prErrors: {} }],
  }));
  return id;
}
export async function remove(id: string) {
  await transact("workspace.json", empty, (s) => ({
    ...s,
    projects: s.projects.filter((p) => p.id !== id),
  }));
}
export async function markSeen() {
  await transact("workspace.json", empty, (s) => ({ ...s, seenAt: new Date().toISOString() }));
}
export function readiness(plan: Plan) {
  const done = new Set(plan.units.filter((u) => u.status === "done").map((u) => u.id));
  return plan.units.map((u) => ({
    ...u,
    dependenciesSatisfied: u.dependsOn.every((id) => done.has(id)),
    canStart:
      u.status === "planned" && u.approval !== "pending" && u.dependsOn.every((id) => done.has(id)),
  }));
}
let refreshing: Promise<void> | undefined;
let retryAt = 0;
function sourceError(e: unknown) {
  if (e instanceof GithubError && e.retryAfterMs !== undefined)
    retryAt = Date.now() + Math.max(60000, e.retryAfterMs);
  return e instanceof Error ? e.message : String(e);
}
export function refresh() {
  if (refreshing) return refreshing;
  refreshing = collect().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}
async function collect() {
  const current = await state();
  let client: GithubClient | undefined;
  const cache = new Map<string, Snapshot>();
  for (const original of current.projects) {
    let next: Project = { ...original, error: undefined };
    const changes: Event[] = [];
    try {
      let plan: Plan, revision: string;
      if (original.kind === "issue") {
        if (Date.now() < retryAt)
          throw new Error(`GitHub rate limited; retry after ${new Date(retryAt).toISOString()}`);
        client ??= new GithubClient({ token: await resolveToken() });
        const issue = await observeIssue(original.source, client);
        next.name = issue.title;
        plan = parsePlan(issue.body);
        revision = issue.revision;
      } else {
        const body = await readFile(original.source, "utf8");
        plan = body.trimStart().startsWith("{")
          ? planSchema.parse(JSON.parse(body))
          : parsePlan(body);
        revision = createHash("sha256").update(body).digest("hex");
      }
      next = {
        ...next,
        plan,
        name: plan.name,
        revision,
        observedAt: new Date().toISOString(),
        prs: {},
        prErrors: {},
      };
      if (original.revision !== revision)
        changes.push({
          id: randomUUID(),
          project: original.id,
          title: original.revision ? "Tracking plan updated" : "Tracking plan connected",
          at: next.observedAt as string,
          source: original.source,
        });
      for (const url of new Set(plan.units.flatMap((u) => u.prs))) {
        try {
          if (Date.now() < retryAt)
            throw new Error(`GitHub rate limited; retry after ${new Date(retryAt).toISOString()}`);
          const ref = parsePrRef(url);
          if (ref?.host !== "github.com") throw new Error("Only github.com PR URLs are supported");
          client ??= new GithubClient({ token: await resolveToken() });
          const snapshot = cache.get(url) ?? (await takeSnapshot(client, ref));
          cache.set(url, snapshot);
          next.prs[url] = snapshot;
          const before = original.prs[url];
          if (
            !before ||
            before.headSha !== snapshot.headSha ||
            before.state !== snapshot.state ||
            before.checks.state !== snapshot.checks.state
          )
            changes.push({
              id: randomUUID(),
              project: original.id,
              title: `${snapshot.title}: ${snapshot.state}, checks ${snapshot.checks.state}`,
              at: snapshot.takenAt,
              source: url,
            });
        } catch (e) {
          next.prErrors[url] = sourceError(e);
          if (original.prs[url]) next.prs[url] = original.prs[url];
        }
      }
    } catch (e) {
      next.error = sourceError(e);
    }
    await transact("workspace.json", empty, (s) => {
      const latest = s.projects.find((p) => p.id === original.id);
      if (!latest || latest.observedAt !== original.observedAt) return s;
      return {
        ...s,
        projects: s.projects.map((p) => (p.id === next.id ? next : p)),
        events: [...changes, ...s.events].slice(0, 1000),
      };
    });
  }
}
export async function dashboard() {
  const s = await state(),
    tasks = await reports();
  return {
    ...s,
    projects: s.projects.map((p) => {
      const units = p.plan ? readiness(p.plan) : [];
      return {
        ...p,
        units,
        completed: units.filter((u) => u.status === "done").length,
        total: units.length,
        stale:
          !!p.error ||
          Object.keys(p.prErrors).length > 0 ||
          !p.observedAt ||
          Date.now() - Date.parse(p.observedAt) > 180000,
        tasks: tasks.filter((t) => t.project === p.id),
        attention: [
          ...(p.error
            ? [
                {
                  id: "source",
                  title: "Tracking source needs attention",
                  detail: p.error,
                  source: p.source,
                  type: "Source",
                },
              ]
            : []),
          ...Object.entries(p.prErrors).map(([url, error]) => ({
            id: url,
            title: "PR observation failed",
            detail: error,
            source: url,
            type: "Source",
          })),
          ...Object.entries(p.prs)
            .filter(
              ([url, pr]) =>
                !p.prErrors[url] && pr.state === "open" && pr.checks.state === "failure",
            )
            .map(([url, pr]) => ({
              id: url,
              title: `Failing checks: ${pr.title}`,
              detail: pr.checks.failing.join(", "),
              source: url,
              type: "Checks",
            })),
          ...units
            .filter((u) => u.status === "blocked")
            .map((u) => ({
              id: u.id,
              title: `Blocked: ${u.title}`,
              detail: u.outcome,
              source: p.source,
              type: "Blocked",
            })),
          ...tasks
            .filter((t) => t.project === p.id && t.stale)
            .map((t) => ({
              id: t.id,
              title: `Heartbeat expired: ${t.agent}`,
              detail: `Last report: ${t.message}`,
              source: p.source,
              type: "Heartbeat",
            })),
          ...units
            .filter((u) => u.approval === "pending" && u.status !== "done")
            .map((u) => ({
              id: u.id,
              title: `Approve scope: ${u.title}`,
              detail: u.outcome,
              source: p.source,
              type: "Scope",
            })),
          ...(p.plan?.decisions
            .filter((d) => d.state === "open")
            .map((d) => ({
              id: d.id,
              title: d.title,
              detail: d.detail,
              source: d.source ?? p.source,
              type: "Decision",
            })) ?? []),
        ],
      };
    }),
  };
}
