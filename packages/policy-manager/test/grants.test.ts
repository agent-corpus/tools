import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "@agent-corpus/audit-log";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  approveCommand,
  approveLastCommand,
  hookResponse,
  looksLikeApproveGrant,
} from "../src/adapters.js";
import { HUMAN_PATTERN, PROTECTED_PATH } from "../src/grants.js";
import { parseProfile, strictProfile } from "../src/profile.js";
import { APPROVE_GUARD, GrantError, PolicySession } from "../src/session.js";
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
    const r = patch(".agent-config/skills/example-skill/references/plan.md");
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
  test("covers later writes to the same protected file of the same worktree only", async () => {
    const { directory, s } = session();
    const first = s.review(
      write(join(worktree, ".agent-config", "skills", "a.md")),
      undefined,
      "PreToolUse",
    );
    expect(s.grant(first.requestHash, true, true).scope).toBe("session");
    const same = [
      {
        ...write(join(worktree, ".agent-config", "skills", "a.md")),
        input: { file_path: join(worktree, ".agent-config", "skills", "a.md"), content: "y" },
      },
      patch(".agent-config/skills/a.md"),
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
      write(join(worktree, ".agent-config", "agents", "b.md")),
      write(join(worktree, ".claude", "settings.json")),
      write(join(worktree, "AGENTS.md")),
      write(join(other, ".agent-config", "skills", "a.md"), other),
      write(join(repo, ".agent-config", "skills", "a.md"), repo),
    ];
    for (const r of outside) expect(s.review(r, undefined, "PreToolUse").decision).toBe("human");
    expect(await events(directory, "human-grant-use")).toHaveLength(2);
  });

  test("covers the same humanPatterns command in the same checkout, not the whole pattern", () => {
    const { s } = session();
    const first = s.review(shell("terraform apply -auto-approve"), undefined, "PreToolUse");
    expect(first.reason).toBe(HUMAN_PATTERN);
    expect(first.sessionGrantable).toBe(true);
    s.grant(first.requestHash, true, true);
    expect(s.review(shell("terraform apply -auto-approve"), undefined, "PreToolUse").decision).toBe(
      "approve",
    );
    expect(s.review(shell("terraform apply plan.out"), undefined, "PreToolUse").decision).toBe(
      "human",
    );
    expect(
      s.review(shell("terraform apply -auto-approve", other), undefined, "PreToolUse").decision,
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

describe("a remembered yes for a protected write in a compound command", () => {
  const first = (dir: string) =>
    `mkdir -p ${dir} && echo "test line appended $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ${dir}/test.md && cat ${dir}/test.md`;
  const second = (dir: string) =>
    `echo "second line appended $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ${dir}/test.md && cat ${dir}/test.md`;
  const bash = (command: string): Request => ({
    ...shell(command),
    harness: "claude",
    tool: "Bash",
  });
  // Test data is built before the repositories exist; OTHER is filled in when run.
  const real = (command: string) => command.replaceAll("OTHER", other.replaceAll("\\", "/"));
  function claude() {
    const directory = join(root, `s${counter++}`);
    mkdirSync(directory, { mode: 0o700 });
    return new PolicySession(directory, "claude", "s1", profile, undefined, {
      nativeRules: () => undefined,
    });
  }
  /** Asks the first command, runs its effect, and reports the yes as Claude Code's PostToolUse. */
  async function approvedFirst(dir: string) {
    const s = claude();
    const asked = await s.decide(bash(first(dir)), "PreToolUse", "toolu_1", "default");
    expect([asked.decision, asked.hard, asked.reason]).toEqual([
      "human",
      "protected",
      PROTECTED_PATH,
    ]);
    expect(asked.sessionGrantable).toBe(true);
    // Windows may report the temp directory by its short (8.3) name, so compare the tail only.
    expect(asked.sessionScopeLabel).toMatch(/^writes to [^,]+$/);
    expect(asked.sessionScopeLabel?.endsWith(join(".worktrees", "feat", dir, "test.md"))).toBe(
      true,
    );
    mkdirSync(join(worktree, dir), { recursive: true });
    appendFileSync(join(worktree, dir, "test.md"), "test line\n");
    const yes = { requestHash: asked.requestHash, phase: "PostToolUse", toolUseId: "toolu_1" };
    expect(s.answered(yes)).toBe("session");
    return s;
  }

  test("covers the next request that writes the same file", async () => {
    const s = await approvedFirst(".agent-config");
    const later = await s.decide(bash(second(".agent-config")), "PreToolUse", "toolu_2", "default");
    expect([later.decision, later.reason]).toEqual([
      "approve",
      "Approved for this session by the user",
    ]);
    // The first command again: its `mkdir -p` only creates the file's own directory.
    expect((await s.decide(bash(first(".agent-config")), "PreToolUse")).decision).toBe("approve");
    // truncate writes only the file it names, so neither it nor a later write is distrusted.
    for (const command of [
      "truncate -s 0 .agent-config/test.md",
      `truncate -s 0 .agent-config/test.md && ${second(".agent-config")}`,
    ])
      expect((await s.decide(bash(command), "PreToolUse")).decision, command).toBe("approve");
  });

  test("approve --session covers it too", () => {
    const { s } = session();
    const asked = s.review(shell(first(".agent-config/codex")), undefined, "PreToolUse");
    expect(asked.sessionGrantable).toBe(true);
    expect(s.grant(asked.requestHash, true, true).scope).toBe("session");
    expect(s.review(shell(second(".agent-config/codex")), undefined, "PreToolUse").decision).toBe(
      "approve",
    );
  });

  test.each([
    [
      "also writes a different protected file",
      `${second(".agent-config")} && echo x >> .agent-config/other.md`,
    ],
    [
      "creates another protected directory",
      `mkdir -p .agent-config/new && ${second(".agent-config")}`,
    ],
    [
      "has a substitution in the redirect target",
      'echo "x" >> .agent-config/$(date +%s).md && cat .agent-config/test.md',
    ],
    [
      "has a variable in the redirect target",
      'echo "x" >> $DIR/test.md && cat .agent-config/test.md',
    ],
    ["has a glob in the redirect target", 'echo "x" >> .agent-config/t*.md'],
    [
      "adds rm -rf outside the worktree",
      `${second(".agent-config")} && rm -rf ~/policy-manager-test-elsewhere`,
    ],
    ["writes harness settings", `${second(".agent-config")} && echo x >> .claude/settings.json`],
    ["writes the file of another checkout", second("OTHER/.agent-config")],
    // The scope's paths are read before the script runs; a link it plants sends the write away.
    [
      "links the file elsewhere first",
      "ln -sf ~/.zshrc .agent-config/test.md && echo evil >> .agent-config/test.md",
    ],
    ["only replaces the file with a link", "ln -sf ~/.zshrc .agent-config/test.md"],
    [
      "copies a link over it first",
      "cp -s ~/.zshrc .agent-config/test.md && echo evil >> .agent-config/test.md",
    ],
    [
      "moves another file over it first",
      "mv ~/policy-manager-test-link .agent-config/test.md && echo evil >> .agent-config/test.md",
    ],
    ["unpacks an archive after the write", `${second(".agent-config")} && tar xf a.tar`],
    ["runs an unknown program after the write", `${second(".agent-config")} && ./build.sh`],
    ["creates a directory at the file's path", "mkdir -p .agent-config/test.md"],
  ])("still asks when the command %s", async (_, command) => {
    const s = await approvedFirst(".agent-config");
    expect((await s.decide(bash(real(command)), "PreToolUse")).decision).toBe("human");
  });

  test.each([
    ["a substitution in the redirect target", "echo x >> .agent-config/$(date +%s).md"],
    [
      "rm -rf outside the worktree",
      `${first(".agent-config")} && rm -rf ~/policy-manager-test-elsewhere`,
    ],
    [
      "an unapproved write elsewhere",
      `${first(".agent-config")} && echo x >> ~/policy-manager-test-out.txt`,
    ],
    ["a credential path", `${first(".agent-config")} && cat ~/.ssh/id_rsa`],
    ["a symlink planted first", `ln -sf ~/.zshrc .agent-config/l.md && ${second(".agent-config")}`],
    ["a symlink planted after", `${first(".agent-config")} && ln -sf ~/.zshrc .agent-config/l.md`],
  ])("a command with %s is approved once only", (_, command) => {
    const { s } = session();
    const asked = s.review(shell(real(command)), undefined, "PreToolUse");
    expect(asked.decision).toBe("human");
    expect(asked.sessionGrantable).toBe(false);
  });

  test("a directory a script creates is named as one in the scope", () => {
    const { s } = session();
    const asked = s.review(shell("mkdir -p .agent-config/dirs/a"), undefined, "PreToolUse");
    expect(asked.sessionGrantable).toBe(true);
    expect(asked.sessionScopeLabel).toMatch(/^writes to directory .*a$/);
  });
});

describe("a write after a command that can plant a symlink is not approved by its path", () => {
  // `ln -s` may point any later path in the script at a file outside the worktree.
  test.each([
    "ln -sf ~/.zshrc x.md && echo evil >> x.md",
    "echo evil >> x.md | ln -sf ~/.zshrc x.md",
    "ln -s ~/policy-manager-test-out.txt out.txt && cat > out.txt < README.md",
    "ln -s ~/policy-manager-test-out.txt out.txt && cp README.md out.txt",
    "ln -s ~/policy-manager-test-out.txt out.txt && echo x | tee out.txt",
    "ln -s ~/policy-manager-test-out.txt out.txt && sed -i s/a/b/ out.txt",
    "ln -s ~/policy-manager-test-out.txt out.txt && truncate -s 0 out.txt",
    "mv a.txt out.txt && echo evil >> out.txt",
  ])("%s", (command) => {
    const { s } = session();
    expect(s.review(shell(command), undefined, "PreToolUse").decision).not.toBe("approve");
  });

  test("the same writes before any such command are still approved", () => {
    const { s } = session();
    for (const command of [
      "echo ok >> x.md && cat x.md",
      "mkdir -p notes && echo ok > notes/a.md && truncate -s 0 notes/a.md",
      "cp README.md out.txt && sed -i s/a/b/ out.txt",
      "truncate -s 0 notes/a.md && echo ok >> notes/a.md",
    ])
      expect(s.review(shell(command), undefined, "PreToolUse").decision, command).toBe("approve");
  });
});

function strictSession() {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  return new PolicySession(directory, "codex", "s1", strictProfile);
}

describe("a session grant on a generic command covers only that command", () => {
  test.each([
    ['bash -c "echo hi"', 'bash -c "rm -rf ~/proj"'],
    ['python3 -c "print(1)"', "python3 -c \"import shutil; shutil.rmtree('/Users/x')\""],
    ["gh api repos/o/r", "gh api -X DELETE repos/o/r"],
    ["gh repo delete o/scratch --yes", "gh repo delete o/prod --yes"],
    ["kubectl delete ns dev", "kubectl delete ns dev --all"],
  ])("approving %s for the session does not approve %s", (command, later) => {
    const s = strictSession();
    const first = s.review(shell(command), undefined, "PreToolUse");
    expect(first.decision).toBe("human");
    s.grant(first.requestHash, true, true);
    expect(s.review(shell(later), undefined, "PreToolUse").decision).not.toBe("approve");
  });

  test("a request with an unknown effect is approved once only", () => {
    const s = strictSession();
    const first = s.review(shell('bash -c "echo hi"'), undefined, "PreToolUse");
    expect(first.category).toBe("unknown");
    expect(first.sessionGrantable).toBe(false);
  });

  test("the preview names what a session approval covers", () => {
    const { s } = session();
    const first = s.review(shell("terraform apply -auto-approve"), undefined, "PreToolUse");
    expect(s.grant(first.requestHash, false, true).sessionScope).toMatch(
      /^the exact command `terraform apply -auto-approve` in /,
    );
    const w = s.review(write(join(worktree, ".agent-config", "a.md")), undefined, "PreToolUse");
    // Windows may report the temp directory by its short (8.3) name, so compare the tail only.
    const label = s.grant(w.requestHash, false, true).sessionScope ?? "";
    expect(label.startsWith("writes to ")).toBe(true);
    expect(label.endsWith(join(".worktrees", "feat", ".agent-config", "a.md"))).toBe(true);
  });
});

describe("the approve guard", () => {
  test("is not itself approvable and offers no approve command", () => {
    const { s } = session();
    const d = s.review(
      shell('node "/opt/pm/dist/cli.js" approve codex s1 x'),
      undefined,
      "PreToolUse",
    );
    expect(d.reason).toBe(APPROVE_GUARD);
    expect(() => s.grant(d.requestHash, false)).toThrow(GrantError);
    const text = JSON.stringify(hookResponse("codex", "PreToolUse", d));
    expect(text).not.toContain("approve codex s1 " + d.requestHash);
    expect(text).toContain("Do not run approve yourself");
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
  test("leads with the wait, puts the command on its own line, and tells the agent to stop", () => {
    const lines = reason(false).split("\n");
    expect(lines[0]).toBe(`⏸ Waiting for your approval. Not run: ${PROTECTED_PATH}.`);
    expect(lines[1]).toBe('Run in your own terminal, then say "retry":');
    expect(lines[2]).toBe('  node "/opt/pm/dist/cli.js" approve --last');
    expect(lines[3]).toMatch(/^Agent: stop now and end your turn/);
    expect(lines.at(-1)).toBe(`Request ${"f".repeat(64)}.`);
    expect(reason(false)).not.toContain("--session");
    expect(reason(false)).not.toMatch(/policy profile/i);
  });
  test("offers --session with the scope it covers", () => {
    const text = (
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
          sessionGrantable: true,
          sessionScopeLabel: "writes under /w/.agent-config",
        },
        context,
      ).hookSpecificOutput as { permissionDecisionReason: string }
    ).permissionDecisionReason;
    expect(text).toContain(
      "Add --session to also allow writes under /w/.agent-config for the rest of this session.",
    );
  });
  test("uses pm when the launcher is installed and on PATH", () => {
    expect(approveLastCommand({ ...context, pmOnPath: true })).toBe("pm approve --last");
  });
  test("keeps the exact approve form for one request", () => {
    expect(approveCommand("codex", "f".repeat(64), context)).toBe(
      `node "/opt/pm/dist/cli.js" approve codex s1 ${"f".repeat(64)}`,
    );
  });
  test("a Windows CLI path is written with forward slashes", () => {
    expect(approveCommand("codex", "a", { cliPath: "D:\\pm\\cli.js", sessionId: "s1" })).toBe(
      'node "D:/pm/cli.js" approve codex s1 a',
    );
  });
});
