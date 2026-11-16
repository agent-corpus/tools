import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
// A stub `claude` on PATH stands in for the classifier CLI: it prints the answer file it is given.
test.skipIf(process.platform === "win32")(
  "the hook classifies with the CLI, asks when it does not approve, and remembers the answer",
  () => {
    const sessionId = `classify-${randomUUID()}`;
    const directory = sessionDirectory("claude", sessionId);
    const config = mkdtempSync(join(tmpdir(), "pm-config-"));
    const bin = join(config, "bin");
    mkdirSync(bin);
    const answer = join(config, "answer.json");
    const args = join(config, "args.txt");
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${args}"\ncat "${answer}"\n`,
      { mode: 0o755 },
    );
    const profileDirectory = join(config, "agent-corpus", "policy-manager");
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(join(profileDirectory, "policy.json"), '{"version":1,"mode":"permissive"}', {
      mode: 0o600,
    });
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: config,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    const verdict = (category: string, recoverable: boolean, confidence: number) =>
      writeFileSync(
        answer,
        JSON.stringify({
          type: "result",
          is_error: false,
          structured_output: { category, confidence, recoverable, rationale: "stub verdict" },
        }),
      );
    const hook = (event: string, command: string, extra: Record<string, unknown> = {}) =>
      execFileSync(process.execPath, [cli, "hook", "claude", event], {
        encoding: "utf8",
        env,
        timeout: 30000,
        input: JSON.stringify({
          session_id: sessionId,
          cwd: process.cwd(),
          tool_name: "Bash",
          tool_input: { command },
          ...extra,
        }),
      });
    const pre = (command: string, extra: Record<string, unknown> = {}) =>
      JSON.parse(hook("PreToolUse", command, extra)).hookSpecificOutput;
    try {
      verdict("code-read", true, 0.97);
      expect(pre("echo $HOOK_CLASSIFIED").permissionDecision).toBe("allow");
      const passed = readFileSync(args, "utf8");
      expect(passed).toContain("--json-schema");
      expect(passed).toContain("disableAllHooks");
      verdict("impactful-write", false, 0.97);
      const asked = pre("echo $HOOK_ASKED", {
        tool_use_id: "toolu_test_1",
        permission_mode: "default",
      });
      expect(asked.permissionDecision).toBe("ask");
      expect(asked.permissionDecisionReason).toContain("did not approve");
      expect(asked.permissionDecisionReason).toContain("stub verdict");
      // The person said yes in the prompt; the tool ran.
      hook("PostToolUse", "echo $HOOK_ASKED", {
        tool_use_id: "toolu_test_1",
        tool_response: { exit_code: 0 },
      });
      const entries = readFileSync(join(directory, "audit.jsonl"), "utf8");
      expect(entries).toContain("User approved the harness prompt");
      expect(entries).toContain('"eventName":"ai-classification"');
      expect(entries).toContain('"model":"haiku"');
      expect(entries).not.toContain("Decide whether");
      // The cached verdict is reused: no second run for the same request.
      writeFileSync(args, "");
      expect(pre("echo $HOOK_CLASSIFIED").permissionDecision).toBe("allow");
      expect(readFileSync(args, "utf8")).toBe("");
      // A hard human item never reaches the classifier.
      verdict("code-read", true, 0.99);
      expect(pre("git push --force origin feature-x").permissionDecision).toBe("ask");
      expect(readFileSync(args, "utf8")).toBe("");
    } finally {
      try {
        execFileSync(process.execPath, [cli, "stop", "claude", sessionId], { env });
      } catch {
        /* The service may not have started. */
      }
      rmSync(directory, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  },
  60000,
);

test("the compatibility classify command cannot settle a request the classifier did not", () => {
  const sessionId = `record-${randomUUID()}`;
  const directory = sessionDirectory("claude", sessionId);
  const config = mkdtempSync(join(tmpdir(), "pm-config-"));
  const profileDirectory = join(config, "agent-corpus", "policy-manager");
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, "policy.json"),
    '{"version":1,"mode":"permissive","classifier":{"enabled":false}}',
    { mode: 0o600 },
  );
  const env = { ...process.env, XDG_CONFIG_HOME: config };
  const payload = {
    session_id: sessionId,
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "echo $RECORD_ROUND_TRIP" },
  };
  const hook = () =>
    JSON.parse(
      execFileSync(process.execPath, [cli, "hook", "claude", "PreToolUse"], {
        encoding: "utf8",
        env,
        timeout: 15000,
        input: JSON.stringify(payload),
      }),
    ).hookSpecificOutput;
  try {
    const asked = hook();
    expect(asked.permissionDecision).toBe("ask");
    expect(asked.permissionDecisionReason).toContain("turned off");
    expect(asked.permissionDecisionReason).not.toContain("classify claude");
    const json = JSON.stringify({
      requestHash: hash(normalize("claude", payload)),
      category: "code-read",
      confidence: 0.97,
      recoverable: true,
      rationale: "prints a variable",
    });
    // A request the classifier could not settle is the person's: a recorded verdict is refused.
    expect(() =>
      execFileSync(process.execPath, [cli, "classify", "claude", sessionId], {
        encoding: "utf8",
        env,
        input: json,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ).toThrow();
    expect(hook().permissionDecision).toBe("ask");
  } finally {
    try {
      execFileSync(process.execPath, [cli, "stop", "claude", sessionId], { env });
    } catch {
      /* The service may not have started. */
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
}, 30000);
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
