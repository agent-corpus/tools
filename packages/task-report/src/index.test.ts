import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { report, reports } from "./index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "task-report-"));
  vi.stubEnv("TRACKER_HOME", dir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
it("expires running heartbeats without inventing a completion and renews them", async () => {
  const input = {
    id: "session",
    project: "project",
    unit: "unit",
    agent: "Worker",
    status: "running",
    message: "Working",
    ttlSeconds: 30,
  };
  const saved = await report(input);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(saved.observedAt) + 31000);
  expect((await reports())[0]?.stale).toBe(true);
  expect((await reports())[0]?.status).toBe("running");
  vi.restoreAllMocks();
  await report(input);
  expect((await reports())[0]?.stale).toBe(false);
  await report({ ...input, status: "done" });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 999999);
  expect((await reports())[0]?.stale).toBe(false);
});
it("scopes report IDs by project and refuses invalid evidence", async () => {
  const r = {
    id: "same",
    project: "one",
    unit: "a",
    agent: "Worker",
    status: "blocked",
    message: "Waiting",
  };
  await report(r);
  await report({ ...r, project: "two" });
  expect(await reports()).toHaveLength(2);
  await expect(report({ ...r, evidence: ["file:///private/key"] })).rejects.toThrow();
});
