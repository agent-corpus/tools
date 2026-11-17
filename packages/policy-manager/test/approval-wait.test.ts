import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hookResponse } from "../src/adapters.js";
import { approvedMessage, approveQuestion, describeRequest, parseAnswer } from "../src/approve.js";
import { sessionDirectory } from "../src/audit.js";
import { hookConfig, WAIT_FLAG, waitStatus } from "../src/config.js";
import { parseProfile } from "../src/profile.js";
import { sendTo, waitForApproval } from "../src/service.js";
import { PolicySession } from "../src/session.js";
import { setupHook } from "../src/setup.js";
import type { Request } from "../src/types.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const profile = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
let root: string, repo: string, worktree: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "approval-wait-test-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
  worktree = join(repo, ".worktrees", "feat");
  git(repo, "worktree", "add", "-b", "feat/a", worktree);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function session() {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  return new PolicySession(directory, "codex", "s1", profile);
}
const shell = (command: string): Request => ({
  sessionId: "s1",
  harness: "codex",
  cwd: worktree,
  tool: "exec_command",
  input: { command },
});
/** A protected write a person must approve, which can be approved for the session. */
const PROTECTED = "printf x >> .github/CODEOWNERS";

describe("a Codex hook waits for the user's approval", () => {
  test("wait, then approve once: the request is allowed, and the next one waits again", async () => {
    const s = session();
    const asked = await s.decide(shell(PROTECTED), "PreToolUse");
    expect(asked.decision).toBe("human");
    expect(s.approvalState(asked.requestHash)).toBe("pending");
    let polls = 0;
    const outcome = await waitForApproval(
      async () => {
        if (++polls === 3) expect(s.grant(asked.requestHash, true).granted).toBe(true);
        return s.approvalState(asked.requestHash);
      },
      Date.now() + 5000,
      1,
    );
    expect(outcome).toBe("granted");
    const after = await s.decide(shell(PROTECTED), "PreToolUse");
    expect(after.decision).toBe("approve");
    // Codex PreToolUse supports no plain allow: an approval is no decision, and the tool runs.
    expect(hookResponse("codex", "PreToolUse", after)).toEqual({});
    // Once: the same request later needs a person again.
    expect((await s.decide(shell(PROTECTED), "PreToolUse")).decision).toBe("human");
  });

  test("approve for the session: the request and later ones for the same scope are allowed", async () => {
    const s = session();
    const asked = await s.decide(shell(PROTECTED), "PreToolUse");
    expect(asked.sessionGrantable).toBe(true);
    const outcome = await waitForApproval(
      async () => {
        s.grant(asked.requestHash, true, true);
        return s.approvalState(asked.requestHash);
      },
      Date.now() + 5000,
      1,
    );
    expect(outcome).toBe("granted");
    expect((await s.decide(shell(PROTECTED), "PreToolUse")).decision).toBe("approve");
    expect((await s.decide(shell("printf y >> .github/CODEOWNERS"), "PreToolUse")).decision).toBe(
      "approve",
    );
    expect((await s.decide(shell("printf y >> .github/OTHER"), "PreToolUse")).decision).toBe(
      "human",
    );
  });

  test("no answer in time: timeout, and the deny says so and still names the command", async () => {
    const s = session();
    const asked = await s.decide(shell(PROTECTED), "PreToolUse");
    const outcome = await waitForApproval(
      async () => s.approvalState(asked.requestHash),
      Date.now() + 30,
      5,
    );
    expect(outcome).toBe("timeout");
    const reason = (
      hookResponse("codex", "PreToolUse", asked, {
        cliPath: "/opt/pm/dist/cli.js",
        sessionId: "s1",
        pmOnPath: true,
        waited: { seconds: 600, outcome: "timeout" },
      }).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string }
    ).permissionDecisionReason;
    const lines = reason.split("\n");
    expect(lines[0]).toBe(
      "⏸ Waiting for your approval. Not run: Protected path requires human approval. No approval came within 10 minutes.",
    );
    expect(reason).toContain("  pm approve --last");
    expect(reason).toContain("just once or, for writes to");
    // The request can still be approved after the deny, and a retry then runs.
    expect(s.approvalState(asked.requestHash)).toBe("pending");
  });

  test("the user declines: the waiting hook stops and denies, and the agent is told not to retry", async () => {
    const s = session();
    const asked = await s.decide(shell(PROTECTED), "PreToolUse");
    const outcome = await waitForApproval(
      async () => {
        s.refuse(asked.requestHash);
        return s.approvalState(asked.requestHash);
      },
      Date.now() + 5000,
      1,
    );
    expect(outcome).toBe("refused");
    const reason = (
      hookResponse("codex", "PreToolUse", asked, {
        cliPath: "/opt/pm/dist/cli.js",
        sessionId: "s1",
        waited: { seconds: 600, outcome: "refused" },
      }).hookSpecificOutput as { permissionDecisionReason: string }
    ).permissionDecisionReason;
    expect(reason).toMatch(/^⏹ You declined this request in your terminal/);
    expect(reason).toContain("do not retry it unchanged");
    expect(() => s.grant(asked.requestHash, true)).toThrow();
  });

  test("a failed poll is not an answer", async () => {
    const outcome = await waitForApproval(
      async () => {
        throw new Error("service gone");
      },
      Date.now() + 20,
      5,
    );
    expect(outcome).toBe("timeout");
  });

  test("a grant result says whether a hook is waiting for it", async () => {
    const s = session();
    const quiet = await s.decide(shell(PROTECTED), "PreToolUse");
    expect(s.grant(quiet.requestHash, true).waiting).toBe(false);
    const polled = await s.decide(shell("printf z >> .github/OTHER"), "PreToolUse");
    s.approvalState(polled.requestHash);
    expect(s.grant(polled.requestHash, true).waiting).toBe(true);
  });
});

describe("pm approve asks once or session", () => {
  test("the question offers a session only when the request can be approved for one", () => {
    expect(approveQuestion(true)).toBe("Allow just this once, or for this session? [o/s/N] ");
    expect(approveQuestion(false)).toBe("Allow just this once? [o/N] ");
  });
  test.each([
    ["o", true, "once"],
    ["once", true, "once"],
    ["y", true, "once"],
    ["s", true, "session"],
    ["Session", true, "session"],
    ["s", false, undefined],
    ["", true, undefined],
    ["n", true, undefined],
    ["yes please", true, undefined],
  ] as const)("answer %j (session offered: %s) chooses %s", (answer, grantable, scope) => {
    expect(parseAnswer(answer, grantable)).toBe(scope);
  });
  test("it shows the session, tool, command, rule and scope label", () => {
    expect(
      describeRequest(
        {
          tool: "exec_command",
          detail: PROTECTED,
          reason: "Protected path requires human approval",
          sessionScope: "writes to /w/.github/CODEOWNERS",
        },
        { harness: "codex", sessionId: "s1" },
      ),
    ).toEqual([
      "Session:  codex s1",
      "Tool:     exec_command",
      `Request:  ${PROTECTED}`,
      "Rule:     Protected path requires human approval",
      "Scope:    writes to /w/.github/CODEOWNERS (if allowed for this session)",
    ]);
  });
  test("after a grant it says whether the waiting request runs now", () => {
    expect(approvedMessage("once", true)).toBe(
      "Approved once. The waiting request runs now; the agent does not need to retry.",
    );
    expect(approvedMessage("session", false)).toBe(
      "Approved for this session. Tell the agent to retry the request unchanged.",
    );
  });
  test("approve outside an interactive terminal is refused, as before", () => {
    let error: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync(process.execPath, [cli, "approve", "--last", "--once"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        input: "o\n",
      });
    } catch (caught) {
      error = caught as { status?: number; stderr?: string };
    }
    expect(error?.status).toBe(1);
    expect(error?.stderr).toContain("Run approve yourself in an interactive terminal");
  });
});

describe("setup gives Codex PreToolUse the wait and a matching timeout", () => {
  type Hook = { command: string; timeout: number; statusMessage?: string };
  const pre = (config: Record<string, unknown>) =>
    ((config.hooks as Record<string, Array<{ hooks: Hook[] }>>).PreToolUse?.[0]?.hooks[0] ??
      {}) as Hook;
  test("default: 10 minutes of waiting, a 645 s timeout and a status line naming approve", () => {
    const hook = pre(
      hookConfig("codex", "/opt/pm/dist/cli.js", { approveCommand: "pm approve --last" }),
    );
    expect(hook.command).toMatch(new RegExp(`hook codex PreToolUse ${WAIT_FLAG} 600 --agent`));
    expect(hook.timeout).toBe(645);
    expect(hook.statusMessage).toBe(waitStatus("pm approve --last"));
  });
  test("0 keeps the deny at once, with the old command and timeout", () => {
    const hook = pre(hookConfig("codex", "/opt/pm/dist/cli.js", { approvalWaitSeconds: 0 }));
    expect(hook.command).not.toContain(WAIT_FLAG);
    expect(hook.timeout).toBe(45);
    expect(hook.statusMessage).toBeUndefined();
  });
  test("Claude and Copilot never wait", () => {
    for (const harness of ["claude", "copilot"] as const)
      expect(JSON.stringify(hookConfig(harness, "/opt/pm/dist/cli.js"))).not.toContain(WAIT_FLAG);
  });
  test("a wait longer than a request stays approvable is refused", () => {
    expect(() =>
      hookConfig("codex", "/opt/pm/dist/cli.js", { approvalWaitSeconds: 900 }),
    ).toThrow();
  });
  test("setup replaces an older managed Codex hook instead of adding a second one", () => {
    const configDirectory = mkdtempSync(join(tmpdir(), "approval-wait-setup-"));
    try {
      const first = setupHook("codex", process.execPath, {
        configDirectory,
        dryRun: true,
        approvalWaitSeconds: 0,
      });
      const second = setupHook("codex", process.execPath, { configDirectory, dryRun: true });
      for (const result of [first, second])
        expect((result.managedHooks.PreToolUse as unknown[]).length).toBe(1);
      expect(second.nextSteps.join("\n")).toContain("waits in the hook for up to 10 minutes");
      expect(first.nextSteps.join("\n")).toContain("returned as a deny");
    } finally {
      rmSync(configDirectory, { recursive: true, force: true });
    }
  });
});

describe("the real Codex PreToolUse hook waits for the user", () => {
  const sessionId = () => `wait-${randomUUID()}`;
  const payload = (id: string) => ({
    session_id: id,
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "az resource delete --ids example-id" },
  });
  function hook(id: string, wait: number): Promise<{ code: number | null; stdout: string }> {
    const child = spawn(
      process.execPath,
      [
        cli,
        "hook",
        "codex",
        "PreToolUse",
        WAIT_FLAG,
        String(wait),
        "--agent-corpus-policy-manager-hook",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stdin.end(JSON.stringify(payload(id)));
    return new Promise((done) => child.on("close", (code) => done({ code, stdout })));
  }
  async function pending(directory: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
      try {
        const found = (await sendTo(directory, { action: "pending" })) as {
          requestHash?: string;
        } | null;
        if (found?.requestHash) return found.requestHash;
      } catch {
        /* the service is starting */
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error("no pending request");
  }
  const stop = (id: string) =>
    execFileSync(process.execPath, [cli, "stop", "codex", id], { stdio: "ignore" });

  test("approve once from the terminal: the hook returns no decision and the tool runs", async () => {
    const id = sessionId();
    try {
      const running = hook(id, 20);
      const directory = sessionDirectory("codex", id);
      const requestHash = await pending(directory);
      const granted = (await sendTo(directory, {
        action: "grant",
        grant: { requestHash, confirm: true },
      })) as { granted: boolean; scope: string };
      expect(granted).toMatchObject({ granted: true, scope: "once" });
      const { code, stdout } = await running;
      expect(code).toBe(0);
      expect(stdout).toBe("");
    } finally {
      stop(id);
    }
  }, 30_000);

  test("no answer within the wait: the hook denies with the approve command", async () => {
    const id = sessionId();
    try {
      const { code, stdout } = await hook(id, 1);
      expect(code).toBe(0);
      const decision = JSON.parse(stdout).hookSpecificOutput as {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
      expect(decision.permissionDecision).toBe("deny");
      expect(decision.permissionDecisionReason).toContain("No approval came within 1 second.");
      expect(decision.permissionDecisionReason).toContain("approve --last");
    } finally {
      stop(id);
    }
  }, 30_000);

  test("declined from the terminal: the hook stops waiting and denies", async () => {
    const id = sessionId();
    try {
      const running = hook(id, 20);
      const directory = sessionDirectory("codex", id);
      const requestHash = await pending(directory);
      await sendTo(directory, { action: "refuse", grant: { requestHash, confirm: false } });
      const { stdout } = await running;
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason).toMatch(
        /^⏹ You declined/,
      );
    } finally {
      stop(id);
    }
  }, 30_000);

  test("an older hook command without the wait denies at once", async () => {
    const id = sessionId();
    try {
      const started = Date.now();
      const child = spawn(process.execPath, [cli, "hook", "codex", "PreToolUse"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stdin.end(JSON.stringify(payload(id)));
      await new Promise((done) => child.on("close", done));
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason).not.toContain(
        "No approval came within",
      );
    } finally {
      stop(id);
    }
  }, 30_000);
});
