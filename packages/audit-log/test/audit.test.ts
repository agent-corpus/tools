import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { AuditBusyError, AuditLog } from "../src/index.js";
import type { EventInput } from "../src/types.js";

const roots: string[] = [];
const event: EventInput = {
  eventName: "permission.request",
  source: "test-tool",
  sessionId: "session-1",
  requestId: "request-1",
  summary: "Read repository file",
  attributes: { category: "code-read" },
};
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function directory() {
  const p = mkdtempSync(join(tmpdir(), "audit-log-test-"));
  roots.push(p);
  return p;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("appends durable versioned records and preserves correlation", async () => {
  const dir = directory(),
    log = new AuditLog(dir);
  const receipt = log.append(event);
  const page = await log.query({ requestId: "request-1" });
  expect(page.records).toHaveLength(1);
  expect(page.records[0]).toEqual(receipt);
  expect(receipt.schemaVersion).toBe(1);
  expect(receipt.eventId).toMatch(/^[a-f0-9-]{36}$/);
  if (process.platform !== "win32") {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "audit.jsonl")).mode & 0o777).toBe(0o600);
  }
});
test("redacts sensitive fields before disk and sanitizes text", async () => {
  const dir = directory(),
    log = new AuditLog(dir);
  log.append({
    ...event,
    summary: "GET Bearer very-secret-token\nnext",
    attributes: {
      nested: {
        api_key: "hidden-api-value",
        password: "hidden-password",
        command: "cat hidden-source",
        stdout: "hidden-output",
      },
      message: "token=hidden-token",
      safe: "visible",
    },
  });
  const text = readFileSync(join(dir, "audit.jsonl"), "utf8");
  for (const secret of [
    "very-secret-token",
    "hidden-api-value",
    "hidden-password",
    "hidden-source",
    "hidden-output",
    "hidden-token",
  ])
    expect(text).not.toContain(secret);
  expect(text.trim().split("\n")).toHaveLength(1);
  expect((await log.query()).records[0]?.attributes.safe).toBe("visible");
});
test("rotates without dropping records and pages across all segments", async () => {
  const dir = directory(),
    log = new AuditLog(dir, { maxFileBytes: 900, maxTotalBytes: 10000 });
  const ids = [];
  for (let i = 0; i < 7; i++)
    ids.push(log.append({ ...event, attributes: { sequence: i } }).eventId);
  expect(readdirSync(dir).some((p) => /^audit\.\d{8}\.jsonl$/.test(p))).toBe(true);
  const a = await log.query({ limit: 3 }),
    b = await log.query({ limit: 3, after: a.nextCursor }),
    c = await log.query({ limit: 3, after: b.nextCursor });
  expect([...a.records, ...b.records, ...c.records].map((r) => r.eventId)).toEqual(ids);
  expect(c.nextCursor).toBeUndefined();
  let exported = "";
  for await (const line of log.export()) exported += line;
  expect(exported.trim().split("\n")).toHaveLength(7);
});
test("capacity failures retain previous records", async () => {
  const dir = directory(),
    log = new AuditLog(dir, { maxFileBytes: 600, maxTotalBytes: 600 });
  const first = log.append(event);
  expect(() => log.append(event)).toThrow("storage limit");
  expect((await log.query()).records.map((r) => r.eventId)).toEqual([first.eventId]);
});
test("filters by time, source, session and request without silently ignoring unknown cursors", async () => {
  const log = new AuditLog(directory());
  log.append({ ...event, timestamp: "2026-11-05T00:00:00Z" });
  const matching = log.append({
    ...event,
    timestamp: "2026-11-06T00:00:00Z",
    source: "second",
    sessionId: "session-2",
    requestId: "request-2",
  });
  const page = await log.query({
    since: "2026-11-06T00:00:00Z",
    until: "2026-11-06T00:00:00Z",
    source: "second",
    sessionId: "session-2",
    requestId: "request-2",
    eventName: event.eventName,
  });
  expect(page.records.map((r) => r.eventId)).toEqual([matching.eventId]);
  await expect(log.query({ after: "missing-cursor" })).rejects.toThrow("cursor");
  await expect(log.query({ since: "not-a-date" })).rejects.toThrow();
  await expect(log.query({ limit: 0 })).rejects.toThrow();
});
test("refuses busy logs and preserves the lock", async () => {
  const dir = directory(),
    log = new AuditLog(dir);
  writeFileSync(join(dir, "audit.lock"), "inspection-required", { mode: 0o600 });
  expect(() => log.append(event)).toThrow(AuditBusyError);
  await expect(log.query()).rejects.toThrow(AuditBusyError);
  expect(readFileSync(join(dir, "audit.lock"), "utf8")).toBe("inspection-required");
});
test("incomplete records are preserved and never silently repaired", async () => {
  const dir = directory(),
    log = new AuditLog(dir);
  log.append(event);
  const path = join(dir, "audit.jsonl"),
    previous = readFileSync(path, "utf8");
  writeFileSync(path, `${previous}{"unfinished":`, { mode: 0o600 });
  expect(() => log.append(event)).toThrow("incomplete");
  await expect(log.query()).rejects.toThrow("incomplete");
  expect(readFileSync(path, "utf8")).toBe(`${previous}{"unfinished":`);
});
test("rejects invalid records and oversized attributes", async () => {
  const dir = directory(),
    log = new AuditLog(dir);
  expect(() => log.append({ ...event, attributes: { invalid: Infinity } })).toThrow();
  expect(() => log.append({ ...event, attributes: { oversized: Array(129).fill(1) } })).toThrow();
  writeFileSync(join(dir, "audit.jsonl"), "{}\n", { mode: 0o600 });
  await expect(log.query()).rejects.toThrow("Invalid audit record");
});
test("queries of absent logs do not create directories", async () => {
  const dir = join(directory(), "missing"),
    log = new AuditLog(dir);
  expect((await log.query()).records).toEqual([]);
  expect(existsSync(dir)).toBe(false);
});
test.skipIf(process.platform === "win32")(
  "rejects exposed directories, symlinks and hard links",
  () => {
    const root = directory(),
      exposed = join(root, "exposed");
    mkdirSync(exposed, { mode: 0o755 });
    chmodSync(exposed, 0o755);
    expect(() => new AuditLog(exposed).append(event)).toThrow("private");
    const victim = join(root, "victim");
    writeFileSync(victim, "untouched", { mode: 0o600 });
    const dir = join(root, "linked");
    mkdirSync(dir, { mode: 0o700 });
    symlinkSync(victim, join(dir, "audit.jsonl"));
    expect(() => new AuditLog(dir).append(event)).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    const hard = join(root, "hard");
    mkdirSync(hard, { mode: 0o700 });
    linkSync(victim, join(hard, "audit.jsonl"));
    expect(() => new AuditLog(hard).append(event)).toThrow();
  },
);
test("CLI append, filtered query and export share the same records", () => {
  const dir = directory();
  const run = (args: string[], input?: string) =>
    execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  const receipt = JSON.parse(run(["append", dir], JSON.stringify(event)));
  const page = JSON.parse(run(["query", dir, "--request-id", "request-1"]));
  expect(page.records[0].eventId).toBe(receipt.eventId);
  expect(JSON.parse(run(["export", dir]).trim()).eventId).toBe(receipt.eventId);
  expect(JSON.parse(run(["usage", "--json"])).usage).toContain("export");
});
test("concurrent CLI writers retain every successful append", async () => {
  const dir = directory();
  const append = () =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "append", dir], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
      child.stdin.end(JSON.stringify(event));
    });
  const codes = await Promise.all(Array.from({ length: 8 }, append));
  expect(codes.every((code) => code === 0 || code === 2)).toBe(true);
  const page = await new AuditLog(dir).query();
  expect(page.records).toHaveLength(codes.filter((code) => code === 0).length);
  expect(page.records.length).toBeGreaterThan(0);
});

test("rejects invalid calendar dates and cyclic attributes before writing", () => {
  const dir = directory(),
    log = new AuditLog(dir);
  expect(() => log.append({ ...event, timestamp: "2026-02-30T00:00:00Z" })).toThrow("calendar");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => log.append({ ...event, attributes: cyclic })).toThrow("nesting");
  expect(existsSync(join(dir, "audit.jsonl"))).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "rejects FIFO storage without blocking the caller",
  () => {
    const dir = directory();
    execFileSync("mkfifo", [join(dir, "audit.jsonl")]);
    const result = spawnSync(process.execPath, [cli, "append", dir], {
      encoding: "utf8",
      input: JSON.stringify(event),
      timeout: 1000,
    });
    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
  },
);
