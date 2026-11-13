import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/** Lock opens fail with these errors, in order, before reaching the real `openSync`. */
const failures: string[] = [];
let lockOpens = 0;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (String(args[0]).endsWith("audit.lock")) {
        lockOpens++;
        const code = failures.shift();
        if (code) throw Object.assign(new Error(code), { code });
      }
      return actual.openSync(...args);
    },
  };
});
const { AuditBusyError, AuditLog } = await import("../src/index.js");

const event = {
  eventName: "permission.request",
  source: "test-tool",
  sessionId: "session-1",
  requestId: "request-1",
  summary: "Read repository file",
};
const platform = process.platform;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-lock-"));
  failures.length = 0;
  lockOpens = 0;
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  rmSync(dir, { recursive: true, force: true });
});

test("a lock another writer is still deleting is busy", () => {
  writeFileSync(join(dir, "audit.lock"), "");
  failures.push("EPERM");
  expect(() => new AuditLog(dir).append(event)).toThrow(AuditBusyError);
});

test("a lock that has just gone is opened on the second try", () => {
  failures.push("EACCES");
  expect(new AuditLog(dir).append(event).eventName).toBe("permission.request");
  expect(lockOpens).toBe(2);
});

test("a permission failure with no lock present is reported as itself", () => {
  failures.push("EPERM", "EPERM");
  expect(() => new AuditLog(dir).append(event)).toThrow("EPERM");
  expect(lockOpens).toBe(2);
});

test("other platforms report EPERM as a failure without retrying", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  failures.push("EPERM");
  expect(() => new AuditLog(dir).append(event)).toThrow("EPERM");
  expect(lockOpens).toBe(1);
});
