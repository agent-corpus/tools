import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "@agent-corpus/audit-log";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hookResponse } from "../src/adapters.js";
import type { ClassifierResult } from "../src/classifier.js";
import { type Profile, parseProfile, strictProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import { setupHook } from "../src/setup.js";
import type { Request } from "../src/types.js";

// Step 3: a person is asked and the harness waits. Claude Code and Copilot ask in their own
// prompt; the PostToolUse that follows means the person said yes, and the answer is remembered
// for the session with the same scope as `approve --session`. Codex cannot ask: it keeps the deny
// with `pm approve --last`.
let root: string, repo: string;
let n = 0;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ask-flow-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const refuse = async (cli: Request["harness"]): Promise<ClassifierResult> => ({
  ok: true,
  cli,
  model: "m",
  latencyMs: 1,
  verdict: { category: "impactful-write", confidence: 0.97, recoverable: false, rationale: "no" },
});
function session(harness: Request["harness"], profile: Profile = strictProfile) {
  const directory = join(root, `s${n++}`);
  mkdirSync(directory, { mode: 0o700 });
  let runs = 0;
  const s = new PolicySession(directory, harness, "s1", profile, undefined, {
    classify: async (cli) => {
      runs++;
      return refuse(cli);
    },
    nativeRules: () => undefined,
  });
  return { s, directory, runs: () => runs };
}
const bash = (command: string, harness: Request["harness"] = "claude"): Request => ({
  sessionId: "s1",
  harness,
  cwd: repo,
  tool: harness === "codex" ? "exec_command" : "Bash",
  input: { command },
});
const executed = (requestHash: string, toolUseId?: string, phase = "PostToolUse") => ({
  requestHash,
  phase,
  ...(toolUseId ? { toolUseId } : {}),
});

describe("Claude Code: ask, wait, remember", () => {
  test("a yes in the prompt is remembered for the same command in this session", async () => {
    const { s, runs, directory } = session("claude");
    const r = bash("az vm restart --name a --resource-group b");
    const asked = await s.decide(r, "PreToolUse", "toolu_1");
    expect(asked.decision).toBe("human");
    expect(hookResponse("claude", "PreToolUse", asked)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
    expect(s.answered(executed(asked.requestHash, "toolu_1"))).toBe("session");
    const again = await s.decide(r, "PreToolUse", "toolu_2");
    expect(again).toMatchObject({
      decision: "approve",
      reason: "Approved for this session by the user",
    });
    expect(runs()).toBe(1);
    // Another command is still asked.
    expect(
      (await s.decide(bash("az vm restart --name other --resource-group b"), "PreToolUse"))
        .decision,
    ).toBe("human");
    const text = readFileSync(join(directory, "audit.jsonl"), "utf8");
    expect(text).toContain("User approved the harness prompt");
    expect(text).toContain('"scope":"session"');
  });

  test("a humanPatterns answer covers that pattern in the same checkout", async () => {
    const profile = parseProfile(
      JSON.stringify({ version: 1, mode: "permissive", humanPatterns: ["^terraform apply"] }),
    );
    const { s, runs } = session("claude", profile);
    const asked = await s.decide(bash("terraform apply"), "PreToolUse", "toolu_p");
    expect(asked).toMatchObject({ decision: "human", hard: "human-patterns" });
    expect(s.answered(executed(asked.requestHash, "toolu_p"))).toBe("session");
    expect((await s.decide(bash("terraform apply -auto-approve"), "PreToolUse")).decision).toBe(
      "approve",
    );
    expect(runs()).toBe(0);
  });

  test("unknown, sensitive and destructive answers stay once-only", async () => {
    const { s } = session("claude");
    for (const command of [
      "git push --force origin x",
      "cat ~/.aws/credentials",
      "frobnicate $X",
    ]) {
      const r = bash(command);
      const asked = await s.decide(r, "PreToolUse", `toolu_${command.length}`);
      expect(asked.decision, command).toBe("human");
      expect(s.answered(executed(asked.requestHash, `toolu_${command.length}`)), command).toBe(
        "once",
      );
      expect((await s.decide(r, "PreToolUse")).decision, command).toBe("human");
    }
  });

  test("a rejected prompt (PostToolUseFailure) is not a yes", async () => {
    const { s, directory } = session("claude");
    const r = bash("az vm restart --name a --resource-group b");
    const asked = await s.decide(r, "PreToolUse", "toolu_r");
    expect(
      s.answered({
        ...executed(asked.requestHash, "toolu_r", "PostToolUseFailure"),
        error: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      }),
    ).toBe("rejected");
    expect((await s.decide(r, "PreToolUse")).decision).toBe("human");
    const records = (await new AuditLog(directory).query({ limit: 100 })).records;
    expect(records.some((rec) => rec.attributes.response === "denied")).toBe(true);
  });

  test("a tool that ran and failed after a yes still counts", async () => {
    const { s } = session("claude");
    const r = bash("az vm restart --name a --resource-group b");
    const asked = await s.decide(r, "PreToolUse", "toolu_f");
    expect(
      s.answered({
        ...executed(asked.requestHash, "toolu_f", "PostToolUseFailure"),
        error: "Exit code 1",
      }),
    ).toBe("session");
  });

  test("only the pending tool_use_id, for the same request, counts", async () => {
    const { s } = session("claude");
    const r = bash("az vm restart --name a --resource-group b");
    const asked = await s.decide(r, "PreToolUse", "toolu_x");
    expect(s.answered(executed(asked.requestHash, "toolu_other"))).toBeUndefined();
    expect(s.answered(executed("f".repeat(64), "toolu_x"))).toBeUndefined();
    // No id: nothing is remembered.
    const noId = await s.decide(bash("az vm restart --name z --resource-group b"), "PreToolUse");
    expect(s.answered(executed(noId.requestHash))).toBeUndefined();
    // PermissionRequest has no tool_use_id and records no pending prompt.
    await s.decide(
      bash("az vm restart --name y --resource-group b"),
      "PermissionRequest",
      "toolu_y",
    );
    expect(s.answered(executed("0".repeat(64), "toolu_y"))).toBeUndefined();
  });
});

describe("Copilot: ask, and remember by request", () => {
  test("postToolUse carries no id, so the pending prompt is matched by the request hash", async () => {
    const { s } = session("copilot");
    const r = bash("az vm restart --name a --resource-group b", "copilot");
    const asked = await s.decide(r, "PreToolUse");
    expect(hookResponse("copilot", "PreToolUse", asked)).toMatchObject({
      permissionDecision: "ask",
    });
    expect(s.answered(executed(asked.requestHash))).toBe("session");
    expect((await s.decide(r, "PreToolUse")).decision).toBe("approve");
  });
});

describe("Codex: unchanged in step 3", () => {
  test("a person is needed: deny with pm approve --last, and nothing waits on PostToolUse", async () => {
    const { s } = session("codex");
    const r = bash("az vm restart --name a --resource-group b", "codex");
    const d = await s.decide(r, "PreToolUse", "call_1");
    const out = JSON.stringify(
      hookResponse("codex", "PreToolUse", d, {
        cliPath: "/opt/cli.js",
        sessionId: "s1",
        pmOnPath: true,
      }),
    );
    expect(out).toContain('"permissionDecision":"deny"');
    expect(out).toContain("pm approve --last");
    expect(out).toContain("Waiting for your approval");
    expect(s.answered(executed(d.requestHash, "call_1"))).toBeUndefined();
    expect(s.latestHumanDecision()?.requestHash).toBe(d.requestHash);
    expect(s.grant(d.requestHash, true, true)).toMatchObject({ granted: true, scope: "session" });
    expect((await s.decide(r, "PreToolUse")).decision).toBe("approve");
  });

  test("only after the classifier or a hard rule said a person is needed", async () => {
    const approving = new PolicySession(
      join(root, `s${n++}`),
      "codex",
      "s1",
      strictProfile,
      undefined,
      {
        classify: async (cli) => ({
          ok: true,
          cli,
          model: "m",
          latencyMs: 1,
          verdict: { category: "code-read", confidence: 0.99, recoverable: true, rationale: "ok" },
        }),
        nativeRules: () => undefined,
      },
    );
    mkdirSync(approving.directory, { mode: 0o700 });
    const d = await approving.decide(bash("echo $X", "codex"), "PreToolUse");
    expect(d.decision).toBe("approve");
    expect(hookResponse("codex", "PreToolUse", d)).toEqual({});
  });
});

describe("setup writes timeouts above the classifier's", () => {
  test.each(["claude", "codex", "copilot"] as const)("%s", (harness) => {
    const configDirectory = mkdtempSync(join(tmpdir(), "ask-flow-setup-"));
    try {
      const result = setupHook(harness, process.execPath, { configDirectory, dryRun: true });
      const hooks = result.managedHooks as Record<string, Array<Record<string, unknown>>>;
      for (const [event, entries] of Object.entries(hooks)) {
        const entry = entries[0] as { timeoutSec?: number; hooks?: Array<{ timeout?: number }> };
        const seconds = harness === "copilot" ? entry.timeoutSec : entry.hooks?.[0]?.timeout;
        if (harness === "codex" && event === "SessionEnd") expect(seconds).toBe(3);
        else expect(seconds, event).toBe(45);
      }
      if (harness !== "codex")
        expect(Object.keys(hooks)).toEqual(
          expect.arrayContaining([
            harness === "copilot" ? "postToolUseFailure" : "PostToolUseFailure",
          ]),
        );
    } finally {
      rmSync(configDirectory, { recursive: true, force: true });
    }
  });
});
