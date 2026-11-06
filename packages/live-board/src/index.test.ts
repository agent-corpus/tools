import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serve } from "./index.js";

let dir: string;
let app: Awaited<ReturnType<typeof serve>>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "live-board-"));
  vi.stubEnv("TRACKER_HOME", dir);
  app = await serve(0);
});
afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
it("protects local mutations from foreign origins and unauthenticated requests", async () => {
  expect(
    (await fetch(`${app.url}/api/session`, { headers: { Origin: "https://attacker.test" } }))
      .status,
  ).toBe(403);
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    get(`${app.url}/api/state`, { headers: { Host: "attacker.test" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  expect(foreignHost).toBe(403);
  expect((await fetch(`${app.url}/api/seen`, { method: "POST" })).status).toBe(403);
  const { token } = (await (await fetch(`${app.url}/api/session`)).json()) as { token: string };
  const headers = { "X-Tracker-Token": token, "Content-Type": "application/json" };
  expect((await fetch(`${app.url}/api/seen`, { method: "POST", headers })).status).toBe(200);
  expect(
    ((await (await fetch(`${app.url}/api/state`)).json()) as { seenAt: string }).seenAt,
  ).toBeTruthy();
  expect(
    (
      await fetch(`${app.url}/api/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "/etc/passwd" }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${app.url}/api/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "https://github.com/../../etc/passwd" }),
      })
    ).status,
  ).toBe(400);
});
it("sends initial state over SSE and accepts durable agent reports", async () => {
  const controller = new AbortController();
  const response = await fetch(`${app.url}/api/events`, { signal: controller.signal });
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  if (!response.body) throw new Error("Missing event stream");
  const reader = response.body.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"projects":[]');
  controller.abort();
  await reader.cancel().catch(() => {});
  const { token } = (await (await fetch(`${app.url}/api/session`)).json()) as { token: string };
  const result = await fetch(`${app.url}/api/tasks`, {
    method: "POST",
    headers: { "X-Tracker-Token": token },
    body: JSON.stringify({
      id: "worker",
      project: "project",
      unit: "unit",
      agent: "Test",
      status: "running",
      message: "Working",
    }),
  });
  expect(result.status).toBe(200);
});
