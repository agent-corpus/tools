import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { normalize } from "../src/adapters.js";
import { sessionDirectory, sessionDirectoryPath } from "../src/audit.js";
import { hookConfig } from "../src/config.js";
import { hash } from "../src/policy.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
test.each(["claude", "codex", "copilot"] as const)(
  "%s hooks start, decide, log, and stop a real service",
  (harness) => {
    const sessionId = `integration-${randomUUID()}`;
    const directory = sessionDirectory(harness, sessionId);
    const raw = (event: string, input: Record<string, unknown>) =>
      execFileSync(process.execPath, [cli, "hook", harness, event], {
        encoding: "utf8",
        input: JSON.stringify(input),
        timeout: 15000,
      });
    // Codex gets no output at all for "no decision".
    const run = (event: string, input: Record<string, unknown>) =>
      JSON.parse(raw(event, input) || "{}");
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
      // The exact text each harness reads for an approved PreToolUse and a human PermissionRequest.
      expect(raw("PreToolUse", payload)).toBe(
        {
          claude:
            '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n',
          codex: "",
          copilot: '{"permissionDecision":"allow"}\n',
        }[harness],
      );
      expect(raw("PermissionRequest", human)).toBe(harness === "codex" ? "" : "{}\n");
      const entries = readFileSync(join(directory, "audit.jsonl"), "utf8");
      expect(entries).toContain('"decision":"human"');
      expect(entries).not.toContain("private-id");
      const recorded = JSON.parse(
        execFileSync(process.execPath, [cli, "record", harness, sessionId], {
          encoding: "utf8",
          input: JSON.stringify({
            event: "human-response",
            requestHash: hash(normalize(harness, payload)),
            response: "approved",
            token: "hidden-human-secret",
          }),
        }),
      );
      expect(recorded.recorded).toBe(true);
      run("PostToolUse", {
        ...payload,
        tool_response: { exit_code: 0, stdout: "hidden-output" },
        duration_ms: 12,
      });
      const after = readFileSync(join(directory, "audit.jsonl"), "utf8");
      expect(after).toContain('"eventName":"execution-result"');
      expect(after).not.toContain("hidden-output");
      expect(after).not.toContain("hidden-human-secret");
      expect(after).toContain('"eventName":"human-response"');
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

test("SessionEnd for a session with no service succeeds and creates nothing", () => {
  const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const sessionId = randomUUID();
  const directory = sessionDirectoryPath("claude", sessionId);
  const out = execFileSync(process.execPath, [cliPath, "hook", "claude", "SessionEnd"], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: sessionId, cwd: process.cwd() }),
    timeout: 15000,
  });
  expect(JSON.parse(out)).toEqual({});
  expect(existsSync(directory)).toBe(false);
});
