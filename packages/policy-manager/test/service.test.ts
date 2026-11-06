import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { sessionDirectory } from "../src/audit.js";
import { hookConfig } from "../src/config.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
test.each(["claude", "codex", "copilot"] as const)(
  "%s hooks start, decide, log, and stop a real service",
  (harness) => {
    const sessionId = `integration-${randomUUID()}`;
    const directory = sessionDirectory(harness, sessionId);
    const run = (event: string, input: Record<string, unknown>) =>
      JSON.parse(
        execFileSync(process.execPath, [cli, "hook", harness, event], {
          encoding: "utf8",
          input: JSON.stringify(input),
          timeout: 15000,
        }),
      );
    let stopped = false;
    const payload = {
      session_id: sessionId,
      sessionId,
      cwd: process.cwd(),
      tool_name: "Bash",
      toolName: "bash",
      tool_input: { command: "az resource list" },
      toolInput: { command: "az resource list" },
    };
    try {
      expect(JSON.stringify(run("SessionStart", payload))).toContain("audit.jsonl");
      expect(JSON.stringify(run("PermissionRequest", payload))).toContain("allow");
      const human = {
        ...payload,
        tool_input: { command: "az resource delete --ids private-id" },
        toolInput: { command: "az resource delete --ids private-id" },
      };
      expect(run("PermissionRequest", human)).toEqual({});
      const entries = readFileSync(join(directory, "audit.jsonl"), "utf8");
      expect(entries).toContain('"decision":"human"');
      expect(entries).not.toContain("private-id");
      run("SessionEnd", payload);
      stopped = true;
      expect(readFileSync(join(directory, "audit.jsonl"), "utf8")).toContain("session-end");
    } finally {
      if (!stopped) {
        try {
          run("SessionEnd", payload);
        } catch {
          /* Service startup can fail before a socket exists. */
        }
      }
      if (process.platform !== "win32")
        expect(existsSync(join(directory, "service.sock"))).toBe(false);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);
test.each(["claude", "codex", "copilot"] as const)(
  "%s config launches only a reviewed installed entrypoint",
  (harness) => {
    const config = hookConfig(harness, cli);
    expect(config.hooks).toBeDefined();
    expect(JSON.stringify(config)).not.toContain("bypass");
    expect(() => hookConfig(harness, "relative/path")).toThrow();
  },
);
