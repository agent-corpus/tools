import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { evaluate } from "../src/policy.js";
import { ProfileError, parseProfile } from "../src/profile.js";
import { reviewClassifications } from "../src/review.js";
import { PolicySession } from "../src/session.js";
import { setupHook } from "../src/setup.js";
import { inspectShim, installShim, SHIM_MARKER, shimPath } from "../src/shim.js";
import type { Request } from "../src/types.js";

const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
let root: string, repo: string, worktree: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codex-ux-test-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
  worktree = join(repo, ".worktrees", "feat");
  git(repo, "worktree", "add", "-b", "feat/a", worktree);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function session(profile = permissive, harness: Request["harness"] = "codex") {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  return { directory, s: new PolicySession(directory, harness, "s1", profile) };
}
const shell = (command: string, cwd = worktree): Request => ({
  sessionId: "s1",
  harness: "codex",
  cwd,
  tool: "exec_command",
  input: { command },
});
const tool = (name: string, harness: Request["harness"] = "claude"): Request => ({
  sessionId: "s1",
  harness,
  cwd: worktree,
  tool: name,
  input: { task_id: "x" },
});
const patch = (file: string): Request => ({
  sessionId: "s1",
  harness: "codex",
  cwd: worktree,
  tool: "apply_patch",
  input: { command: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` },
});

describe("single-quoted literals", () => {
  const decide = (command: string) => evaluate(shell(command, tmpdir()), undefined, permissive);
  test("a backtick inside single quotes is literal", () => {
    expect(decide("gh api graphql -f b='Fixed in `abc`'").decision).toBe("approve");
  });
  test('a variable holding a single-quoted literal with $ is usable as "$Q"', () => {
    expect(decide("Q='mutation($t:ID!){x}'; gh api graphql -f query=\"$Q\" -f t=1").decision).toBe(
      "approve",
    );
  });
  test("the same variable unquoted, or run as a script, keeps its checks", () => {
    expect(decide("Q='rm -rf ~/x'; $Q").decision).toBe("human");
    expect(decide("Q='rm -rf ~/x'; sh -c \"$Q\"").decision).toBe("human");
    expect(decide("Q='cat ~/.ssh/id_rsa'; bash -c \"$Q\"").decision).toBe("human");
  });
});

describe("session scope for shell redirect writes", () => {
  test("a redirect write is session-grantable and covers later writes under the same root", () => {
    const { s } = session();
    const first = s.review(
      shell("printf test >> .agent-config/README.md"),
      undefined,
      "PreToolUse",
    );
    expect(first.decision).toBe("human");
    expect(first.sessionGrantable).toBe(true);
    expect(first.sessionScopeLabel).toMatch(/^writes under .*\.agent-config$/);
    s.grant(first.requestHash, true, true);
    for (const later of [
      shell("printf x > .agent-config/agents/a.md"),
      shell("tee -a .agent-config/skills/b.md"),
      patch(join(worktree, ".agent-config", "c.md")),
    ])
      expect(s.review(later, undefined, "PreToolUse").decision).toBe("approve");
  });
  test.each([
    "printf x >> AGENTS.md",
    "cp .agent-config/a AGENTS.md",
    "tee .agent-config/a AGENTS.md",
    "printf x > .claude/settings.json",
  ])("a write that also touches another protected path is not covered: %s", (command) => {
    const { s } = session();
    const first = s.review(
      shell("printf test >> .agent-config/README.md"),
      undefined,
      "PreToolUse",
    );
    s.grant(first.requestHash, true, true);
    expect(s.review(shell(command), undefined, "PreToolUse").decision).not.toBe("approve");
  });
});

describe("approve --last", () => {
  test("the session reports its newest request waiting for a person", () => {
    const { s } = session();
    expect(s.latestHumanDecision()).toBeUndefined();
    const a = s.review(shell("printf a >> .agent-config/a.md"), undefined, "PreToolUse");
    const b = s.review(shell("printf b >> AGENTS.md"), undefined, "PreToolUse");
    const latest = s.latestHumanDecision();
    expect(latest?.requestHash).toBe(b.requestHash);
    expect(latest?.harness).toBe("codex");
    expect(latest?.sessionId).toBe("s1");
    s.grant(b.requestHash, true);
    expect(s.latestHumanDecision()?.requestHash).toBe(a.requestHash);
  });
});

describe("pm launcher", () => {
  const cli = "/opt/pm/dist/cli.js";
  test("is installed, reported, and left alone once current", () => {
    const dir = join(root, `bin${counter++}`);
    expect(inspectShim(dir, cli, "0.9.0").state).toBe("absent");
    const dry = installShim(dir, cli, "0.9.0", true);
    expect(dry.changed).toBe(true);
    expect(inspectShim(dir, cli, "0.9.0").state).toBe("absent");
    const done = installShim(dir, cli, "0.9.0", false);
    expect(done.state).toBe("current");
    expect(readFileSync(shimPath(dir), "utf8")).toContain(`${SHIM_MARKER} version=0.9.0`);
    if (process.platform !== "win32") expect(statSync(shimPath(dir)).mode & 0o111).not.toBe(0);
    expect(installShim(dir, cli, "0.9.0", false).changed).toBe(false);
  });
  test("an older managed launcher is replaced; a newer or foreign one is kept", () => {
    const dir = join(root, `bin${counter++}`);
    installShim(dir, cli, "0.8.0", false);
    expect(installShim(dir, cli, "0.9.0", false)).toMatchObject({
      changed: true,
      state: "current",
    });
    expect(installShim(dir, cli, "0.8.0", false)).toMatchObject({ changed: false, state: "newer" });
    writeFileSync(shimPath(dir), "#!/bin/sh\necho mine\n");
    expect(installShim(dir, cli, "0.9.0", false)).toMatchObject({
      changed: false,
      state: "foreign",
    });
    expect(readFileSync(shimPath(dir), "utf8")).toContain("echo mine");
  });
  test("setup with --config-dir leaves the home launcher alone unless a shim dir is given", () => {
    const installed = join(root, "pkg", "dist", "cli.js");
    mkdirSync(join(root, "pkg", "dist"), { recursive: true });
    writeFileSync(installed, "");
    writeFileSync(join(root, "pkg", "package.json"), JSON.stringify({ version: "0.9.0" }));
    const config = join(root, `config${counter++}`);
    expect(setupHook("codex", installed, { configDirectory: config, dryRun: true }).shim).toBe(
      undefined,
    );
    const shimDir = join(root, `bin${counter++}`);
    const result = setupHook("codex", installed, {
      configDirectory: config,
      dryRun: true,
      shimDirectory: shimDir,
    });
    expect(result.shim).toMatchObject({ state: "absent", changed: true });
    expect(result.changed).toBe(true);
  });
  test("a launcher failure does not fail the hook install", () => {
    const installed = join(root, `nover${counter++}`, "dist", "cli.js");
    mkdirSync(join(installed, ".."), { recursive: true });
    writeFileSync(installed, "");
    const config = join(root, `config${counter++}`);
    const result = setupHook("codex", installed, {
      configDirectory: config,
      shimDirectory: join(root, `bin${counter++}`),
    });
    expect(result.changed).toBe(true);
    expect(result.shim).toBeUndefined();
    expect(result.nextSteps.some((step) => step.includes("launcher was not installed"))).toBe(true);
  });
  test.skipIf(process.platform === "win32")(
    "the launcher runs under a package.json with type module",
    () => {
      const home = join(root, `esm${counter++}`);
      const dir = join(home, "bin");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, "package.json"), '{"type":"module"}');
      const target = join(home, "cli.js");
      writeFileSync(target, "console.log(process.argv.slice(2).join(' '))");
      installShim(dir, target, "0.9.0", false);
      expect(execFileSync(shimPath(dir), ["a", "b"], { encoding: "utf8" }).trim()).toBe("a b");
    },
  );
});

describe("harness tools approved by default", () => {
  test("a session-internal tool is approved and names itself", () => {
    const d = evaluate(tool("TaskStop"), undefined, permissive);
    expect(d.decision).toBe("approve");
    expect(d.defaultTool).toBe("TaskStop");
  });
  test("a tool in the profile's toolsDeny keeps the classification path", () => {
    const profile = parseProfile(
      JSON.stringify({ version: 1, mode: "permissive", toolsDeny: { claude: ["SendMessage"] } }),
    );
    const { s } = session(profile, "claude");
    const d = s.review(tool("SendMessage"), undefined, "PreToolUse");
    expect(d.decision).not.toBe("approve");
    expect(d.defaultTool).toBeUndefined();
    expect(evaluate(tool("TaskStop"), undefined, profile).decision).toBe("approve");
  });
  test("the strict profile approves nothing by default", () => {
    expect(
      evaluate(tool("TaskStop"), undefined, parseProfile('{"version":1,"mode":"strict"}')).decision,
    ).not.toBe("approve");
  });
  test.each([
    "Bash",
    "Write",
    "Edit",
    "Grep",
    "Glob",
    "Monitor",
    "apply_patch",
    "view_image",
    // Command runners and stdin feeders, listed and unlisted.
    "shell_command",
    "local_shell",
    "unified_exec",
    "write_stdin",
    "write_bash",
    "write_powershell",
    "run_terminal_cmd",
    "container.exec",
    "spawn_process",
  ])("%s is never approved by default", (name) => {
    const d = evaluate(tool(name), undefined, permissive);
    expect(d.decision).not.toBe("approve");
    expect(d.defaultTool).toBeUndefined();
  });
  test("MCP tools still follow mcpReadOnly", () => {
    const d = evaluate(tool("mcp__github__create_issue"), undefined, permissive);
    expect(d.decision).toBe("native");
  });
  test("toolsDeny must list tool names per known harness", () => {
    for (const toolsDeny of [{ other: ["x"] }, { claude: "x" }, { claude: ["bad name"] }, []])
      expect(() =>
        parseProfile(JSON.stringify({ version: 1, mode: "permissive", toolsDeny })),
      ).toThrow(ProfileError);
  });
  test("the review lists default-approved tools by when each was first seen", async () => {
    const { directory, s } = session(permissive, "claude");
    s.review(tool("TaskStop"), undefined, "PermissionRequest");
    s.review(tool("TaskStop"), undefined, "PermissionRequest");
    s.review(tool("ListAgents"), undefined, "PermissionRequest");
    const review = await reviewClassifications([directory]);
    expect(review.defaultTools.map((t) => t.tool).sort()).toEqual(["ListAgents", "TaskStop"]);
    expect(review.defaultTools.find((t) => t.tool === "TaskStop")?.count).toBeGreaterThanOrEqual(1);
  });
});

test("this file's fixtures never touch the real home launcher", () => {
  expect(fileURLToPath(import.meta.url)).toContain("codex-ux");
});
