import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report } from "@agent-corpus/task-report";
import { planSchema } from "@agent-corpus/tracker-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dashboard, readiness, refresh, register, remove } from "./index.js";

let dir: string;
const plan = {
  version: 1,
  id: "sample",
  name: "Sample",
  units: [
    { id: "a", title: "First", status: "done", approval: "not-required" },
    { id: "b", title: "Second", status: "planned", dependsOn: ["a"], approval: "pending" },
  ],
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "project-watch-"));
  vi.stubEnv("TRACKER_HOME", join(dir, "state"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
it("keeps dependency readiness separate from scope approval", () => {
  const units = readiness(planSchema.parse(plan));
  expect(units[1]?.dependenciesSatisfied).toBe(true);
  expect(units[1]?.canStart).toBe(false);
  const approved = structuredClone(plan);
  approved.units = approved.units.map((u) => ({ ...u, approval: "not-required" }));
  expect(readiness(planSchema.parse(approved))[1]?.canStart).toBe(true);
});
it("retains the last valid plan on failure, recovers, and deduplicates observations", async () => {
  const file = join(dir, "plan.json");
  await writeFile(file, JSON.stringify(plan));
  const id = await register(file);
  expect(await register(file)).toBe(id);
  await Promise.all([refresh(), refresh()]);
  let d = await dashboard();
  expect(d.projects).toHaveLength(1);
  expect(d.events).toHaveLength(1);
  expect(d.projects[0]?.completed).toBe(1);
  await writeFile(file, "broken");
  await refresh();
  d = await dashboard();
  expect(d.projects[0]?.stale).toBe(true);
  expect(d.projects[0]?.plan?.name).toBe("Sample");
  await writeFile(file, JSON.stringify({ ...plan, name: "Updated" }));
  await refresh();
  d = await dashboard();
  expect(d.projects[0]?.error).toBeUndefined();
  expect(d.projects[0]?.name).toBe("Updated");
  expect(d.events).toHaveLength(2);
  await report({
    id: "agent",
    project: id,
    unit: "b",
    agent: "Worker",
    status: "done",
    message: "Reported done",
  });
  d = await dashboard();
  expect(d.projects[0]?.tasks).toHaveLength(1);
  expect(d.projects[0]?.completed).toBe(1);
  await remove(id);
  expect((await dashboard()).projects).toHaveLength(0);
});

it("normalizes issue sources before registration", async () => {
  const first = await register("https://github.com/Owner/Repo/issues/123/");
  expect(await register("https://github.com/owner/repo/issues/123")).toBe(first);
  expect((await dashboard()).projects).toHaveLength(1);
});
