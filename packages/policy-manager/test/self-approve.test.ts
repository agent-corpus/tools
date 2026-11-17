import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { looksLikeApproveGrant } from "../src/adapters.js";
import { harnessCommand, harnessOf, insideAgent, type ProcessInfo } from "../src/ancestry.js";
import { hardRules } from "../src/hard.js";
import { evaluate } from "../src/policy.js";
import { parseProfile, strictProfile } from "../src/profile.js";
import { APPROVE_GUARD, GrantError, PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

// An agent must never satisfy its own approval: not by running approve under any name, not from
// a terminal it owns, and not by reading the session token and talking to the service itself.
const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
let root: string,
  repo: string,
  feature: string,
  counter = 0;
const slash = (path: string) => path.replace(/\\/g, "/");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "self-approve-test-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "AGENTS.md"), "x");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init");
  feature = join(repo, ".worktrees", "feat");
  git(repo, "worktree", "add", "-b", "feat/a", feature);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function session(profile = permissive) {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  return new PolicySession(directory, "codex", "s1", profile, undefined, {
    classify: async () => {
      throw new Error("the classifier must not run");
    },
  });
}
const shell = (command: string, cwd = feature): Request => ({
  sessionId: "s1",
  harness: "codex",
  cwd,
  tool: "exec_command",
  input: { command },
});

describe("an agent command that runs approve, under any name, goes to a person", () => {
  test.each([
    "pm approve --last --once",
    "pm approve --last --session",
    "script -q /dev/null pm approve --last --once",
    "~/.local/bin/pm approve --last",
    "/Users/me/.local/bin/pm approve --last --once",
    "env pm approve --last",
    "env -i PATH=/usr/bin pm approve --last",
    "pm.cmd approve --last",
    "C:\\Users\\me\\AppData\\Local\\agent-corpus\\bin\\pm.cmd approve --last",
    'sh -c "pm approve --last --once"',
    "echo o | pm approve --last",
    "unbuffer pm approve --last --once",
    "expect -c 'spawn pm approve --last; send o\\r'",
    "echo --last | xargs pm approve",
    "npx -y @agent-corpus/policy-manager approve --last --once",
    "npm exec @agent-corpus/policy-manager -- approve --last",
    "node /opt/pm/dist/cli.js approve --last --once",
    '"pm" "approve" --last',
    "p\\m approve --last",
    "pm app''rove --last",
  ])("%s", async (command) => {
    expect(looksLikeApproveGrant(command)).toBe(true);
    for (const profile of [permissive, strictProfile]) {
      const s = session(profile);
      const d = await s.decide(shell(command), "PreToolUse");
      expect(d.decision).toBe("human");
      expect(d.reason).toBe(APPROVE_GUARD);
      expect(d.hard).toBe("self-approve");
      expect(d.sessionGrantable).toBe(false);
      // Never approvable, not even once.
      expect(() => s.grant(d.requestHash, false)).toThrow(GrantError);
      expect(s.latestHumanDecision()).toBeUndefined();
    }
  });

  test.each([
    "npm run pm",
    "echo approved",
    "gh pr review 5 --approve",
    "git commit -m 'approve flow'",
    "grep -rn approve src",
    "pnpm install",
  ])("a command that is neither keeps its decision: %s", (command) =>
    expect(looksLikeApproveGrant(command)).toBe(false),
  );
});

describe("any agent command that runs the CLI is self-approve, however the subcommand is spelled", () => {
  test.each([
    "x=appr; pm ${x}ove --last --once",
    "a=ove; pm appr$a --last --once",
    "( script -q /dev/null pm approve --last --once & ); sleep 3",
    '( script -q /dev/null node /opt/pm/node_modules/@agent-corpus/policy-manager/dist/cli.js "$s" --last & )',
    "p=pm; $p approve --last",
    "$(command -v pm) --last --once",
    "pm $(printf appr)ove --last",
    "pm review-classifications --since $X",
    "pm stop codex s1",
    "nohup pm serve codex s1 &",
    "node /usr/local/lib/node_modules/@agent-corpus/policy-manager/dist/cli.js anything",
    "npx -y @agent-corpus/policy-manager@0.11.2 record codex s1",
    "pnpm dlx @agent-corpus/policy-manager approve",
    "bash -c 'pm $1' _ approve",
    "cat <<'EOF' | sh\npm approve --last --once\nEOF",
    "sh <<'EOF'\npm approve --last\nEOF",
    "expect -c 'spawn pm app$x; send o'",
    "tmux new -d 'pm approve --last --once'",
    "setsid pm approve --last --once",
  ])("%s", async (command) => {
    const s = session();
    const d = await s.decide(shell(command), "PreToolUse");
    expect(d.decision).toBe("human");
    expect(d.reason).toBe(APPROVE_GUARD);
    expect(d.hard).toBe("self-approve");
    expect(d.sessionGrantable).toBe(false);
    expect(() => s.grant(d.requestHash, false)).toThrow(GrantError);
  });

  test.each([
    "pm --help",
    "pm --version",
    "pm review-classifications",
    "pm review-classifications --since 2026-11-01T00:00:00Z",
    "policy-manager setup-hook-codex --dry-run",
    "pm setup-hook codex --dry-run",
    "pm profile validate policy.json",
  ])("a literal read-only subcommand is not self-approve: %s", async (command) => {
    const s = session();
    const d = await s.decide(shell(command), "PreToolUse");
    expect(d.reason).not.toBe(APPROVE_GUARD);
  });

  test.each(["npm run pm", "grep -rn pm src", "echo pm", "pnpm install", "git log -- pm"])(
    "naming pm as data is not running it: %s",
    async (command) => {
      const s = session();
      const d = await s.decide(shell(command), "PreToolUse");
      expect(d.reason).not.toBe(APPROVE_GUARD);
    },
  );
});

describe("approve refuses a terminal below an agent harness", () => {
  const table = (rows: Array<[number, number, string]>) =>
    new Map<number, ProcessInfo>(rows.map(([pid, ppid, command]) => [pid, { ppid, command }]));
  // launchd 1 > Terminal 10 > zsh 11 > codex 20 > sh 21 > script 22 > zsh 23 > pm 24
  // launchd 1 > Terminal 10 > zsh 30 > pm 31 (the user's own tab)
  const tree = table([
    [1, 0, "/sbin/launchd"],
    [10, 1, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"],
    [11, 10, "-zsh"],
    [20, 11, "codex"],
    [21, 20, "/bin/sh -c pm approve --last --once"],
    [22, 21, "script -q /dev/null pm approve --last --once"],
    [23, 22, "/bin/zsh"],
    [24, 23, "node /Users/me/.local/bin/pm approve --last --once"],
    [30, 10, "-zsh"],
    [31, 30, "node /Users/me/.local/bin/pm approve --last"],
    [40, 11, "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js"],
    [41, 40, "/bin/bash -c pm approve"],
    [42, 41, "node /Users/me/.local/bin/pm approve"],
    [50, 11, "/usr/local/bin/my-agent"],
    [51, 50, "/bin/sh -c hook"],
    [52, 51, "node cli.js hook codex PreToolUse"],
    [53, 50, "/bin/sh -c pm approve"],
    [54, 53, "node pm approve"],
  ]);
  test("an agent's own PTY (script inside codex) is refused", () => {
    expect(insideAgent([], 24, tree)).toMatch(/inside an agent session/);
  });
  test("an npm-installed harness is recognised too", () => {
    expect(insideAgent([], 42, tree)).toMatch(/inside an agent session/);
  });
  test("a live session's recorded harness process is refused whatever its name", () => {
    // The hook records only a process that is a harness; an unnamed host is not guessed.
    expect(harnessOf(52, tree)).toBeUndefined();
    expect(insideAgent([50], 54, tree)).toMatch(/inside an agent session/);
    expect(insideAgent([], 54, tree)).toBeUndefined();
  });
  test("every live session counts, not only the one being approved", () => {
    expect(insideAgent([99, 50], 54, tree)).toMatch(/inside an agent session/);
  });
  test("the user's own terminal is allowed", () => {
    expect(insideAgent([20, 40, 50], 31, tree)).toBeUndefined();
  });
  test("an unreadable process table fails closed", () => {
    expect(insideAgent([20], 31, null as unknown as undefined)).toBeDefined();
  });
  test("harness names: argv[0], or argv[1] under node, up to a path boundary", () => {
    expect(harnessCommand("codex")).toBe(true);
    expect(harnessCommand("/Users/me/.local/bin/claude --resume")).toBe(true);
    expect(harnessCommand("node /opt/homebrew/bin/claude")).toBe(true);
    expect(harnessCommand("node /x/node_modules/@openai/codex/bin/codex.js")).toBe(true);
    expect(harnessCommand("node /x/node_modules/@github/copilot/index.js")).toBe(true);
    expect(harnessCommand("/Applications/Claude.app/Contents/MacOS/Claude")).toBe(true);
    expect(harnessCommand("node /x/node_modules/@github/copilot-sdk/index.js")).toBe(false);
    expect(harnessCommand("/bin/zsh -c cd /x/@openai/codex/ && ls")).toBe(false);
    expect(harnessCommand("tmux new -s claude")).toBe(false);
    expect(harnessCommand("-zsh")).toBe(false);
  });
  test("Windows: a parent created after its child is a reused PID and ends the chain", () => {
    const reused = new Map<number, ProcessInfo>([
      [5, { ppid: 0, command: "explorer.exe", created: 1 }],
      [7, { ppid: 5, command: "C:\\x\\claude.exe", created: 900 }],
      [8, { ppid: 7, command: "pwsh.exe", created: 100 }],
      [9, { ppid: 8, command: "pm.cmd approve --last", created: 200 }],
    ]);
    expect(insideAgent([], 9, reused)).toBeUndefined();
  });
});

describe("the policy service's files are a credential read, except the audit logs", () => {
  let dir: string;
  beforeAll(() => {
    dir = join(tmpdir(), `acp-${process.getuid?.() ?? "user"}-${"cd".repeat(12)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "token"), "t");
    writeFileSync(join(dir, "grants.json"), "{}");
    writeFileSync(join(dir, "audit.jsonl"), "{}\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Shell commands name paths with forward slashes, as a Windows shell (Git Bash) needs them.
  const slashed = (path: string) => path.replace(/\\/g, "/");
  const temp = () => slashed(tmpdir());
  const tool = (name: string, input: Record<string, unknown>): Request => ({
    sessionId: "s1",
    harness: "codex",
    cwd: feature,
    tool: name,
    input,
  });
  const sdir = () => slashed(dir);
  const read = (file: string): Request => ({
    sessionId: "s1",
    harness: "codex",
    cwd: feature,
    tool: "Read",
    input: { file_path: file },
  });
  test.each([
    () => read(join(dir, "token")),
    () => read(join(dir, "service.sock")),
    () => read(join(dir, "grants.json")),
    () => shell(`cat ${sdir()}/token`),
    () => shell("cat $TMPDIR/acp-*/token"),
    () => shell(`head ${temp()}/acp-*/t*`),
    () => shell(`cat ${sdir()}/*`),
    () => shell(`cat < ${sdir()}/token`),
    () => shell(`grep -r x ${temp()}`),
    () => shell(`rg secret ${sdir()}`),
    () => shell(`cp -r ${sdir()} /tmp/copy`),
    () => shell(`tail -f ${sdir()}/grants.json`),
    () => tool("Grep", { pattern: ".", path: dir, output_mode: "content" }),
    () => tool("Grep", { pattern: "[a-f0-9]{32}", path: tmpdir(), output_mode: "content" }),
    () => tool("Glob", { pattern: "**/*", path: dir }),
    () => tool("LS", { path: dir }),
    () => tool("NotebookRead", { notebook_path: join(dir, "token") }),
    () => tool("grep", { pattern: ".", path: dir }),
  ])("%#: never approved, a hard credential read", async (make) => {
    const request = make();
    for (const profile of [permissive, strictProfile]) {
      const d = evaluate(request, undefined, profile);
      expect(d.decision, JSON.stringify(request.input)).toBe("human");
      expect(hardRules(request, d)).toContain("credential-read");
      const s = session(profile);
      const decided = await s.decide(request, "PreToolUse");
      expect(decided.decision).toBe("human");
      // Hard either way: a read inside the state is also the policy-state rule. Never classified,
      // and never approved for the session.
      expect(["credential-read", "policy-state"]).toContain(decided.hard);
      expect(decided.sessionGrantable).toBe(false);
    }
  });
  test("Grep in a checkout is not a credential read", () => {
    const request = tool("Grep", { pattern: "x", path: feature });
    expect(hardRules(request, { ...evaluate(request), decision: "human" })).not.toContain(
      "credential-read",
    );
  });
  test.each([
    () => read(join(dir, "audit.jsonl")),
    () => shell(`tail -5 ${sdir()}/audit.jsonl`),
    () => shell(`ls ${sdir()}`),
    () => shell(`ls -la ${temp()}`),
  ])("%#: audit logs and listings stay approved", (make) => {
    for (const profile of [permissive, strictProfile])
      expect(evaluate(make(), undefined, profile).decision).toBe("approve");
  });
});

describe("restoring a protected file in the main checkout is a protected write", () => {
  test.each([
    () => `git -C ${slash(repo)} checkout -- AGENTS.md`,
    () => `git -C ${slash(repo)} restore AGENTS.md`,
    () => `git -C ${slash(repo)} checkout HEAD -- AGENTS.md`,
    () => `git -C ${slash(repo)} restore --source HEAD --worktree -- AGENTS.md`,
  ])("%#: hard, never classified", async (make) => {
    const s = session();
    const d = await s.decide(shell(make()), "PreToolUse");
    expect(d.decision).toBe("human");
    expect(d.hard).toBe("protected");
  });
  test("in the feature worktree AGENTS.md is ordinary code", () => {
    const d = evaluate(shell("git checkout -- AGENTS.md"), undefined, permissive);
    expect(
      hardRules(shell("git checkout -- AGENTS.md"), { ...d, decision: "human" }),
    ).not.toContain("protected");
  });
});

describe("a worktree whose default branch is unknown is not a feature worktree", () => {
  test("no origin/HEAD and no main or master: AGENTS.md stays protected", () => {
    const other = join(root, "develop-repo");
    mkdirSync(other);
    git(other, "init", "-b", "develop");
    git(other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "i");
    const linked = join(other, ".worktrees", "x");
    git(other, "worktree", "add", "-b", "feat/x", linked);
    const write: Request = {
      sessionId: "s1",
      harness: "claude",
      cwd: linked,
      tool: "Write",
      input: { file_path: "AGENTS.md", content: "x" },
    };
    expect(evaluate(write, undefined, permissive).decision).toBe("human");
    expect(evaluate({ ...write, input: { file_path: "src/a.ts", content: "x" } }).decision).toBe(
      "approve",
    );
  });
});
