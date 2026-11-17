import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PROTECTED_PATH } from "../src/grants.js";
import { evaluate } from "../src/policy.js";
import { defaultProfilePath, parseProfile, strictProfile } from "../src/profile.js";
import type { Request } from "../src/types.js";

// Agent instructions and shared agent configuration are ordinary code in a linked feature
// worktree; harness settings and hooks, CI and the policy profile stay protected everywhere, and
// all of them stay protected in the main checkout and on the default branch.
const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
let root: string, repo: string, feature: string, trunk: string, detached: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-config-test-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".agent-config"), { recursive: true });
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "AGENTS.md"), "x");
  writeFileSync(join(repo, ".agent-config", "a.md"), "x");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init");
  feature = join(repo, ".worktrees", "feat");
  git(repo, "worktree", "add", "-b", "feat/config", feature);
  // A linked worktree on origin's default branch (here "trunk"), and a detached one.
  trunk = join(repo, ".worktrees", "trunk");
  git(repo, "worktree", "add", "-b", "trunk", trunk);
  git(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  detached = join(repo, ".worktrees", "detached");
  git(repo, "worktree", "add", "--detach", detached);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (cwd: string, file: string): Request => ({
  sessionId: "s",
  harness: "claude",
  cwd,
  tool: "Write",
  input: { file_path: file, content: "x" },
});
const bash = (cwd: string, command: string): Request => ({
  sessionId: "s",
  harness: "claude",
  cwd,
  tool: "Bash",
  input: { command },
});
const patch = (cwd: string, file: string): Request => ({
  sessionId: "s",
  harness: "codex",
  cwd,
  tool: "apply_patch",
  input: { command: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` },
});

const CODE = [
  ".agent-config/a.md",
  ".agent-config/skills/review/SKILL.md",
  ".agents/skills/x/SKILL.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/AGENTS.md",
  "packages/x/CLAUDE.md",
];
const STILL_PROTECTED = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks/x.sh",
  ".claude/CLAUDE.md",
  ".codex/config.toml",
  ".codex/hooks.json",
  ".codex/rules/default.rules",
  ".github/workflows/ci.yml",
  ".github/hooks/policy.json",
  ".agent-config/.claude/settings.json",
  ".agents/.codex/config.toml",
];

describe.each([
  ["permissive", permissive],
  ["strict", strictProfile],
])("%s profile", (_name, profile) => {
  test.each(CODE)("in a linked feature worktree %s is ordinary code", (file) => {
    const d = evaluate(write(feature, file), undefined, profile);
    expect(d.decision).toBe("approve");
    expect(d.reason).toBe("Write within a linked feature worktree");
  });

  test.each(STILL_PROTECTED)("in a linked feature worktree %s stays protected", (file) => {
    const d = evaluate(write(feature, file), undefined, profile);
    expect(d.decision).toBe("human");
  });

  test.each([
    ["the main checkout", () => repo],
    ["a linked worktree on the default branch", () => trunk],
    ["a detached linked worktree", () => detached],
  ])("in %s .agent-config, .agents, AGENTS.md and CLAUDE.md stay protected", (_where, cwd) => {
    for (const file of CODE) {
      const d = evaluate(write(cwd(), file), undefined, profile);
      expect(d.decision, file).toBe("human");
      expect(d.reason, file).toBe(PROTECTED_PATH);
    }
  });

  test("plain reads stay approved, in the worktree and the main checkout", () => {
    for (const cwd of [feature, repo])
      for (const file of [...CODE, ".claude/settings.json"]) {
        const read: Request = { ...write(cwd, file), tool: "Read", input: { file_path: file } };
        expect(evaluate(read, undefined, profile).decision, `${cwd} ${file}`).toBe("approve");
      }
  });
});

describe("shell and patch writes follow the same rule", () => {
  test.each([
    "echo x >> .agent-config/test.md",
    "mkdir -p .agents/skills/y && printf x > .agents/skills/y/SKILL.md",
    "sed -i.bak s/x/y/ AGENTS.md",
    "cat AGENTS.md .agent-config/a.md",
  ])("in a linked feature worktree: %s", (command) => {
    expect(evaluate(bash(feature, command), undefined, permissive).decision).toBe("approve");
  });

  test.each(["echo x >> .agent-config/test.md", "sed -i.bak s/x/y/ AGENTS.md"])(
    "in the main checkout: %s",
    (command) => {
      expect(evaluate(bash(repo, command), undefined, permissive).decision).toBe("human");
    },
  );

  test.each([
    "echo x >> .claude/settings.json",
    "echo x >> .codex/config.toml",
    "echo x >> .github/workflows/ci.yml",
  ])("still protected in a linked feature worktree: %s", (command) => {
    expect(evaluate(bash(feature, command), undefined, permissive).decision).toBe("human");
  });

  test("cat of protected configuration in the main checkout is a plain read", () => {
    expect(
      evaluate(bash(repo, "cat AGENTS.md .agent-config/a.md"), undefined, permissive).decision,
    ).toBe("approve");
  });

  test("apply_patch", () => {
    expect(evaluate(patch(feature, ".agent-config/b.md"), undefined, permissive).decision).toBe(
      "approve",
    );
    expect(evaluate(patch(feature, ".codex/config.toml"), undefined, permissive).decision).toBe(
      "human",
    );
    expect(evaluate(patch(repo, ".agent-config/b.md"), undefined, permissive).decision).toBe(
      "human",
    );
  });

  test("the policy profile stays protected", () => {
    const d = evaluate(write(feature, defaultProfilePath()), undefined, permissive);
    expect(d.decision).toBe("human");
  });
});
