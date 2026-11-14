import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "@agent-corpus/audit-log";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { approveCommand, hookResponse, looksLikeApproveGrant } from "../src/adapters.js";
import { HUMAN_PATTERN, PROTECTED_PATH } from "../src/grants.js";
import { parseProfile } from "../src/profile.js";
import { GrantError, PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

const profile = parseProfile(
  JSON.stringify({ version: 1, mode: "permissive", humanPatterns: ["^terraform apply"] }),
);
let root: string, repo: string, worktree: string, other: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "grants-test-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
  worktree = join(repo, ".worktrees", "feat");
  other = join(repo, ".worktrees", "other");
  git(repo, "worktree", "add", "-b", "feat/a", worktree);
  git(repo, "worktree", "add", "-b", "feat/b", other);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function session(harness: Request["harness"] = "codex") {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  return { directory, s: new PolicySession(directory, harness, "s1", profile) };
}
const write = (path: string, cwd = worktree): Request => ({
  sessionId: "s1",
  harness: "codex",
  cwd,
  tool: "Write",
  input: { file_path: path, content: "x" },
});
const shell = (command: string, cwd = worktree): Request => ({
  sessionId: "s1",
  harness: "codex",
  cwd,
  tool: "exec_command",
  input: { command },
});
const patch = (file: string): Request => ({
  sessionId: "s1",
  harness: "codex",
  cwd: worktree,
  tool: "apply_patch",
  input: { command: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` },
});
const events = async (directory: string, name: string) =>
  (await new AuditLog(directory).query({ limit: 1000 })).records.filter(
    (r) => r.eventName === name,
  );

describe("one-time approval", () => {
  test("a protected-path write the user approves runs once per hook phase", async () => {
    const { directory, s } = session();
    const r = write(join(worktree, ".agent-config", "skills", "a.md"));
    const first = s.review(r, undefined, "PreToolUse");
    expect(first.decision).toBe("human");
    expect(first.reason).toBe(PROTECTED_PATH);
    expect(first.sessionGrantable).toBe(true);
    const preview = s.grant(first.requestHash, false);
    expect(preview).toMatchObject({ granted: false, scope: "once", tool: "Write" });
    expect(preview.detail).toContain("a.md");
    expect(s.grant(first.requestHash, true).granted).toBe(true);
    const retry = s.review(r, undefined, "PreToolUse");
    expect(retry.decision).toBe("approve");
    expect(retry.reason).toBe("Approved once by the user");
    expect(s.review(r, undefined, "PermissionRequest").decision).toBe("approve");
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("human");
    // A one-time grant covers nothing else.
    expect(
      s.review(write(join(worktree, ".agent-config", "b.md")), undefined, "PreToolUse").decision,
    ).toBe("human");
    expect(await events(directory, "human-grant")).toHaveLength(1);
    expect(await events(directory, "human-grant-use")).toHaveLength(2);
    expect(await events(directory, "human-response")).toHaveLength(1);
  });

  test("a Codex apply_patch retry after approval has the same hash and runs", () => {
    const { s } = session();
    const r = patch(".agent-config/skills/workstream-tracker/references/plan.md");
    const first = s.review(r, undefined, "PreToolUse");
    expect([first.decision, first.reason]).toEqual(["human", PROTECTED_PATH]);
    s.grant(first.requestHash, true);
    const retry = s.review({ ...r, input: { ...r.input } }, undefined, "PreToolUse");
    expect(retry.requestHash).toBe(first.requestHash);
    expect(retry.decision).toBe("approve");
  });

  test("an unknown, approved or stale hash is refused", () => {
    const { s } = session();
    expect(() => s.grant("a".repeat(64), true)).toThrow(GrantError);
    expect(() => s.grant("nope", true)).toThrow(GrantError);
    const first = s.review(write(join(worktree, ".agent-config", "c.md")), undefined, "PreToolUse");
    s.grant(first.requestHash, true);
    expect(() => s.grant(first.requestHash, true)).toThrow(/Retry the request/);
  });

  test("another session cannot approve it", () => {
    const one = session().s;
    const two = session().s;
    const first = one.review(
      write(join(worktree, ".agent-config", "d.md")),
      undefined,
      "PreToolUse",
    );
    expect(() => two.grant(first.requestHash, true)).toThrow(GrantError);
  });
});

describe("session approval", () => {
  test("covers later writes under the same protected root of the same worktree only", async () => {
    const { directory, s } = session();
    const first = s.review(
      write(join(worktree, ".agent-config", "skills", "a.md")),
      undefined,
      "PreToolUse",
    );
    expect(s.grant(first.requestHash, true, true).scope).toBe("session");
    const same = [
      write(join(worktree, ".agent-config", "agents", "b.md")),
      patch(".agent-config/skills/x/SKILL.md"),
    ];
    for (const r of same) {
      const d = s.review(r, undefined, "PreToolUse");
      expect([r.tool, d.decision, d.reason]).toEqual([
        r.tool,
        "approve",
        "Approved for this session by the user",
      ]);
    }
    const outside = [
      write(join(worktree, ".claude", "settings.json")),
      write(join(worktree, "AGENTS.md")),
      write(join(other, ".agent-config", "skills", "a.md"), other),
      write(join(repo, ".agent-config", "skills", "a.md"), repo),
    ];
    for (const r of outside) expect(s.review(r, undefined, "PreToolUse").decision).toBe("human");
    expect(await events(directory, "human-grant-use")).toHaveLength(2);
  });

  test("covers the same humanPatterns entry in the same checkout, not other rules", () => {
    const { s } = session();
    const first = s.review(shell("terraform apply -auto-approve"), undefined, "PreToolUse");
    expect(first.reason).toBe(HUMAN_PATTERN);
    expect(first.sessionGrantable).toBe(true);
    s.grant(first.requestHash, true, true);
    expect(s.review(shell("terraform apply plan.out"), undefined, "PreToolUse").decision).toBe(
      "approve",
    );
    expect(
      s.review(shell("terraform apply plan.out", other), undefined, "PreToolUse").decision,
    ).toBe("human");
    expect(s.review(shell("git push --force origin HEAD"), undefined, "PreToolUse").decision).toBe(
      "human",
    );
  });

  test.each([
    ["a credential read", "cat ~/.ssh/id_rsa", "cat ~/.ssh/id_ed25519"],
    ["a force push", "git push --force origin HEAD", "git push --force origin feat/a"],
  ])("%s stays one-time even with --session", (_, command, later) => {
    const { s } = session();
    const first = s.review(shell(command), undefined, "PreToolUse");
    expect(first.decision).toBe("human");
    expect(first.sessionGrantable).toBe(false);
    const granted = s.grant(first.requestHash, true, true);
    expect(granted.scope).toBe("once");
    expect(s.review(shell(command), undefined, "PreToolUse").decision).toBe("approve");
    expect(s.review(shell(later), undefined, "PreToolUse").decision).toBe("human");
  });

  test("a compound command is never covered by a session scope", () => {
    const { s } = session();
    const first = s.review(shell("terraform apply x"), undefined, "PreToolUse");
    s.grant(first.requestHash, true, true);
    const d = s.review(shell("terraform apply y && rm -rf /tmp/z"), undefined, "PreToolUse");
    expect(d.decision).toBe("human");
  });
});

describe("only the user approves", () => {
  const cli = "/opt/pm/dist/cli.js";
  test.each([
    `node "${cli}" approve codex s1 ${"a".repeat(64)}`,
    `node ${cli} approve codex s1 ${"a".repeat(64)} --session`,
    `env A=1 node "${cli}" approve claude s2 x`,
    `sh -c 'node "${cli}" approve codex s1 x'`,
    `bash -lc "cd /tmp && policy-manager approve codex s1 x"`,
    "npx -y @agent-corpus/policy-manager@0.8.0 approve codex s1 x",
    `echo y | node "${cli}" "approve" codex s1 x`,
  ])("an agent command that approves goes to a person: %s", (command) => {
    expect(looksLikeApproveGrant(command)).toBe(true);
    const { s } = session();
    const d = s.review(shell(command), undefined, "PreToolUse");
    expect(d.decision).toBe("human");
    expect(d.reason).toContain("Only the user may approve");
    expect(d.sessionGrantable).toBe(false);
  });
  test.each(["grep -rn approve src", "git commit -m 'approve flow'", "echo approved"])(
    "a command that only mentions approval keeps the normal decision: %s",
    (command) => expect(looksLikeApproveGrant(command)).toBe(false),
  );
  test("stays fast on a long run of program names", () => {
    const start = performance.now();
    expect(looksLikeApproveGrant("policy-manager@".repeat(50_000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("approve CLI", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "approve", ...args], { encoding: "utf8", input: "y\n" });
  test("refuses without an interactive terminal, so piped input cannot approve", () => {
    const out = run("codex", "s1", "a".repeat(64));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("interactive terminal");
  });
  test("rejects malformed arguments", () => {
    const out = run("codex", "s1", "not-a-hash");
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("Usage: policy-manager approve");
  });
});

describe("Codex deny message", () => {
  const context = { cliPath: "/opt/pm/dist/cli.js", sessionId: "s1" };
  const reason = (sessionGrantable: boolean) =>
    (
      hookResponse(
        "codex",
        "PreToolUse",
        {
          decision: "human",
          category: "sensitive",
          reason: PROTECTED_PATH,
          requestHash: "f".repeat(64),
          cache: "none",
          cached: false,
          sessionGrantable,
        },
        context,
      ).hookSpecificOutput as { permissionDecisionReason: string }
    ).permissionDecisionReason;
  test("names the exact approve command, once by default", () => {
    const text = reason(false);
    expect(text).toContain(approveCommand("codex", "f".repeat(64), context));
    expect(text).toContain("To allow it once");
    expect(text).toContain("retry the same request unchanged");
    expect(text).not.toContain("--session");
    expect(text).not.toMatch(/policy profile/i);
  });
  test("offers --session when the rule has a session scope", () => {
    expect(reason(true)).toContain("--session");
  });
  test("a Windows CLI path is written with forward slashes", () => {
    expect(approveCommand("codex", "a", { cliPath: "D:\\pm\\cli.js", sessionId: "s1" })).toBe(
      'node "D:/pm/cli.js" approve codex s1 a',
    );
  });
});
