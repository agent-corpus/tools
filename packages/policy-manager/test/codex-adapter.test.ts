import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { executionReport, hookResponse } from "../src/adapters.js";
import { hookConfig } from "../src/config.js";
import { PolicySession } from "../src/session.js";
import { setupHook } from "../src/setup.js";
import type { Category, Decision } from "../src/types.js";

const decision = (kind: Decision["decision"], category: Category = "destructive"): Decision => ({
  decision: kind,
  category,
  reason: "Destructive operation requires human approval",
  requestHash: "abc123",
  cache: "none",
  cached: false,
});
const CATEGORIES: Category[] = [
  "code-read",
  "worktree-write",
  "cloud-read",
  "git-read",
  "impactful-write",
  "destructive",
  "sensitive",
  "unknown",
];
const cli = "/opt/policy-manager/dist/cli.js";

describe("Codex PreToolUse", () => {
  // Codex parses permissionDecision "ask" but does not support it: the hook is marked failed and
  // the tool call continues. A deny is the only shape that stops a command.
  test("a human decision is a deny with the policy reason", () => {
    const out = hookResponse("codex", "PreToolUse", decision("human"));
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining(
          "Destructive operation requires human approval",
        ),
      },
    });
    const reason = (out.hookSpecificOutput as { permissionDecisionReason: string })
      .permissionDecisionReason;
    expect(reason).toContain("was not run");
    expect(reason).toContain("abc123");
  });
  // Approving in chat cannot change a deterministic decision: the retry is denied again. The reason
  // must not invite that loop.
  test("the reason says approving in chat does not unblock the command", () => {
    const reason = (
      hookResponse("codex", "PreToolUse", decision("human")).hookSpecificOutput as {
        permissionDecisionReason: string;
      }
    ).permissionDecisionReason;
    expect(reason).toContain("does not unblock it");
    expect(reason).toContain("run it themselves");
    expect(reason).toContain("policy profile");
    expect(reason).not.toMatch(/ask the user to approve/i);
    expect(reason).not.toMatch(/classif/i);
  });
  test("an ambiguous cloud request keeps the classification route", () => {
    const reason = (
      hookResponse("codex", "PreToolUse", {
        ...decision("human", "cloud-read"),
        needsClassification: true,
      }).hookSpecificOutput as { permissionDecisionReason: string }
    ).permissionDecisionReason;
    expect(reason).toContain("Classify it with the session policy-manager agent and retry");
    expect(reason).toContain("run it themselves");
    expect(reason).not.toContain("does not unblock it");
  });
  test("an approval is an allow", () =>
    expect(hookResponse("codex", "PreToolUse", decision("approve"))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    }));
  test.each(CATEGORIES)(
    "a human decision (%s) never produces an allow or ask shape",
    (category) => {
      type Out = {
        hookSpecificOutput?: {
          permissionDecision?: string;
          decision?: { behavior?: string };
          updatedInput?: unknown;
        };
      };
      for (const phase of ["PreToolUse", "PermissionRequest"]) {
        const out = hookResponse("codex", phase, decision("human", category)) as Out;
        const specific = out.hookSpecificOutput ?? {};
        expect([undefined, "deny"]).toContain(specific.permissionDecision);
        expect([undefined, "deny"]).toContain(specific.decision?.behavior);
        expect(specific.updatedInput).toBeUndefined();
        // Nothing at the top level may be a decision either.
        expect(Object.keys(out).filter((key) => key !== "hookSpecificOutput")).toEqual([]);
      }
      // PreToolUse is the event where a human decision must stop the command.
      const pre = hookResponse("codex", "PreToolUse", decision("human", category)) as Out;
      expect(pre.hookSpecificOutput?.permissionDecision).toBe("deny");
    },
  );
});

describe("Codex PermissionRequest", () => {
  test("a human decision falls through to Codex's own approval prompt", () =>
    expect(hookResponse("codex", "PermissionRequest", decision("human"))).toEqual({}));
  test("an approval allows the request", () =>
    expect(hookResponse("codex", "PermissionRequest", decision("approve"))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    }));
});

describe("Claude and Copilot output is pinned", () => {
  test("Claude", () => {
    expect(hookResponse("claude", "PreToolUse", decision("human"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "Destructive operation requires human approval",
      },
    });
    expect(hookResponse("claude", "PreToolUse", decision("approve"))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    expect(hookResponse("claude", "PermissionRequest", decision("human"))).toEqual({});
    expect(hookResponse("claude", "PermissionRequest", decision("approve"))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });
  test("Copilot", () => {
    expect(hookResponse("copilot", "PreToolUse", decision("human"))).toEqual({
      permissionDecision: "ask",
      permissionDecisionReason: "Destructive operation requires human approval",
    });
    expect(hookResponse("copilot", "PreToolUse", decision("approve"))).toEqual({
      permissionDecision: "allow",
    });
    expect(hookResponse("copilot", "PermissionRequest", decision("human"))).toEqual({});
    expect(hookResponse("copilot", "PermissionRequest", decision("approve"))).toEqual({
      behavior: "allow",
    });
  });
});

describe("hook timeouts", () => {
  type Hook = { timeout?: number; timeoutSec?: number };
  const timeouts = (harness: "claude" | "codex" | "copilot") => {
    const hooks = hookConfig(harness, cli).hooks as Record<string, unknown[]>;
    return Object.fromEntries(
      Object.entries(hooks).map(([phase, entries]) => {
        const entry = entries[0] as Hook & { hooks?: Hook[] };
        const hook = entry.hooks?.[0] ?? entry;
        return [phase, hook.timeout ?? hook.timeoutSec];
      }),
    );
  };
  // Codex limits SessionEnd to 1 to 3 seconds and warns about anything longer.
  test("Codex SessionEnd is 3 seconds and the other Codex hooks are unchanged", () => {
    const t = timeouts("codex");
    expect(t.SessionEnd).toBe(3);
    for (const phase of ["SessionStart", "PreToolUse", "PermissionRequest", "PostToolUse"])
      expect(t[phase]).toBe(8);
  });
  test("Claude and Copilot keep 8 seconds everywhere", () => {
    for (const harness of ["claude", "copilot"] as const)
      for (const value of Object.values(timeouts(harness))) expect(value).toBe(8);
  });
});

describe("Codex PostToolUse execution reports", () => {
  const request = (harness: "claude" | "codex" | "copilot") => ({
    sessionId: "s",
    harness,
    cwd: "/tmp",
    tool: "Bash",
    input: { command: "ls" },
  });
  // The real Codex payload carries tool_response as the command's output text, with no exit code
  // and no duration, even for a command that exited 1.
  test.each([
    ["a plain string", "a.txt\n"],
    ["a failing command's output", "ls: /nonexistent: No such file or directory\n"],
    ["an empty string", ""],
    ["a missing response", undefined],
    ["an object without an exit code", { output: "x" }],
  ])("records unknown when the exit status is not exposed (%s)", (_name, response) => {
    const report = executionReport(request("codex"), "PostToolUse", {
      tool_response: response,
    });
    expect(report.status).toBe("unknown");
    expect(report.exitCode).toBeUndefined();
  });
  test("uses a structured exit code when Codex sends one", () => {
    expect(
      executionReport(request("codex"), "PostToolUse", { tool_response: { exit_code: 0 } }).status,
    ).toBe("succeeded");
    const failed = executionReport(request("codex"), "PostToolUse", {
      tool_response: { exitCode: 3 },
    });
    expect(failed.status).toBe("failed");
    expect(failed.exitCode).toBe(3);
  });
  test("never copies tool output into the report", () => {
    const report = executionReport(request("codex"), "PostToolUse", {
      tool_response: "token=private-output-value\n",
    });
    expect(JSON.stringify(report)).not.toContain("private-output-value");
  });
  test("Claude and Copilot keep recording completed when there is no exit code", () => {
    for (const harness of ["claude", "copilot"] as const)
      expect(
        executionReport(request(harness), "PostToolUse", { tool_response: "plain output" }).status,
      ).toBe("completed");
  });
  test("a recorded unknown status is accepted by the session", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    try {
      const audit = join(directory, "audit");
      mkdirSync(audit, { mode: 0o700 });
      const session = new PolicySession(audit, "codex", "s");
      expect(() =>
        session.record({
          requestHash: "a".repeat(64),
          event: "execution-result",
          status: "unknown",
        }),
      ).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("setup output", () => {
  const preview = (harness: "claude" | "codex" | "copilot") => {
    const directory = mkdtempSync(join(tmpdir(), "codex-setup-"));
    try {
      return setupHook(harness, fileURLToPath(import.meta.url), {
        dryRun: true,
        configDirectory: directory,
      }).nextSteps.join(" ");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  test("Codex setup explains that trust is tied to the command text, and the deny", () => {
    const text = preview("codex");
    expect(text).toContain("/hooks");
    expect(text).toContain("does not grant hook trust");
    expect(text).toContain("trusts the command text, not the code behind it");
    expect(text).toContain("review a new version before upgrading in place");
    expect(text).toContain("trust it again");
    expect(text).toContain("returned as a deny");
    expect(text).toContain("approving it in chat does not unblock it");
  });
  test("Claude and Copilot setup output has no Codex-only text", () => {
    for (const harness of ["claude", "copilot"] as const) {
      const text = preview(harness);
      expect(text).not.toContain("/hooks");
      expect(text).not.toContain("deny");
    }
  });
});
