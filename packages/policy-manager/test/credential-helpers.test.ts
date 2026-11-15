import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { matchShape } from "../src/helpers.js";
import { evaluate } from "../src/policy.js";
import { ProfileError, parseProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

const STATUS = ".agent-config/skills/code-review/review-status.mjs";
const AUTH = ".agent-config/skills/code-review/app-auth.mjs";
const SHA = "38fdd662fe6810766469c1e580588f946299cecf";
const helpers = [
  {
    path: STATUS,
    args: [
      ["start", "--repo", "<repo>", "--pr", "<int>", "--head", "<sha>", "--as-app"],
      [
        "fail",
        "--repo",
        "<repo>",
        "--pr",
        "<int>",
        "--head",
        "<sha>",
        "--reason",
        "<text>",
        "--as-app",
      ],
    ],
  },
  {
    path: AUTH,
    args: [
      ["--repo", "<repo>", "check"],
      ["--repo", "<repo>", "gh", "api", "repos/<repo>/pulls/<int>/reviews", "--input", "<file>"],
      [
        "--repo",
        "<repo>",
        "gh",
        "pr",
        "review",
        "<int>",
        "-R",
        "<repo>",
        ["--approve", "--comment"],
        "--body-file",
        "<file>",
      ],
    ],
  },
];
const profile = parseProfile(
  JSON.stringify({ version: 1, mode: "permissive", credentialHelpers: helpers }),
);

// A backslash in an unquoted shell word is an escape, so commands name paths with `/`.
const posix = (path: string) => path.split("\\").join("/");
let root: string, worktree: string, changed: string, outside: string, rw: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
const bash = (command: string, cwd = worktree, p = profile) =>
  evaluate(
    { sessionId: "t", harness: "claude", cwd, tool: "Bash", input: { command } },
    undefined,
    p,
  );

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "helpers-test-")));
  const source = join(root, "source");
  execFileSync("git", ["init", "-b", "main", source], { stdio: "ignore" });
  mkdirSync(join(source, ".agent-config", "skills", "code-review"), { recursive: true });
  writeFileSync(join(source, STATUS), "// status\n");
  writeFileSync(join(source, AUTH), "// auth\n");
  git(source, "add", ".");
  git(source, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "helpers");
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", source, clone], { stdio: "ignore" });
  worktree = join(clone, ".worktrees", "feat");
  git(clone, "worktree", "add", "-b", "feat/a", worktree);
  changed = join(clone, ".worktrees", "changed");
  git(clone, "worktree", "add", "-b", "feat/b", changed);
  appendFileSync(join(changed, AUTH), "console.log('extra');\n");
  outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "app-auth.mjs"), "// auth\n");
  rw = join(root, "rw");
  mkdirSync(rw);
  writeFileSync(join(rw, "review.json"), "{}");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("credential helpers", () => {
  test("a listed helper with an accepted shape is approved and named", () => {
    const d = bash(
      `node ${STATUS} start --repo caredocs-ai/agent-config --pr 82 --head ${SHA} --as-app`,
    );
    expect(d.decision).toBe("approve");
    expect(d.reason).toBe("Listed credential helper");
    expect(d.credentialHelpers).toEqual([`${STATUS}#0`]);
  });
  test("by absolute path, with a file argument and a placeholder inside a word", () => {
    const d = bash(
      `node ${posix(join(worktree, AUTH))} --repo a/b gh api repos/a/b/pulls/7/reviews --input ${posix(join(rw, "review.json"))}`,
    );
    expect(d.decision).toBe("approve");
    expect(d.credentialHelpers).toEqual([`${AUTH}#1`]);
    expect(
      bash(
        `node ${AUTH} --repo a/b gh pr review 7 -R a/b --comment --body-file ${posix(join(rw, "review.json"))}`,
      ).decision,
    ).toBe("approve");
  });
  test("works inside the reviewer's compound script, and git reads stay symlink-free", () => {
    const script = [
      `cd ${posix(worktree)} && N=82 REPO=caredocs-ai/agent-config; RW=${posix(rw)}/82; mkdir -p $RW`,
      `node ${STATUS} start --repo $REPO --pr $N --head ${SHA} --as-app`,
      `git fetch origin "+pull/$N/head:pr$N" && git fetch origin main && git rev-parse pr$N`,
      "git diff --name-only origin/main...pr$N | tee $RW/files.txt",
      "git diff origin/main...pr$N",
    ].join("\n");
    const d = bash(script);
    expect(d.reason).not.toMatch(/symlink/);
    expect(d.decision).toBe("approve");
    expect(d.credentialHelpers).toEqual([`${STATUS}#0`]);
  });
  test.each([
    ["extra arguments", `node ${STATUS} start --repo a/b --pr 1 --head ${SHA} --as-app --x`],
    ["a bad placeholder value", `node ${STATUS} start --repo a/b --pr x --head ${SHA} --as-app`],
    ["a gh command outside the list", `node ${AUTH} --repo a/b gh repo delete a/b --yes`],
    [
      "an api path for another resource",
      `node ${AUTH} --repo a/b gh api repos/a/b/pulls/7/merge --input x`,
    ],
    [
      "an alternative not listed",
      `node ${AUTH} --repo a/b gh pr review 7 -R a/b --request-changes --body-file x`,
    ],
  ])("%s goes to a person", (_name, command) => {
    const d = bash(command);
    expect(d.decision).toBe("human");
    expect(d.category).toBe("sensitive");
  });
  test("a helper changed from the default branch goes to a person", () => {
    const d = bash(`node ${AUTH} --repo a/b check`, changed);
    expect(d.decision).toBe("human");
    expect(d.reason).toMatch(/differs from the default branch/);
  });
  test("an untracked copy at the helper's path goes to a person", () => {
    const repo = join(root, "untracked");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    mkdirSync(join(repo, ".agent-config", "skills", "code-review"), { recursive: true });
    writeFileSync(join(repo, AUTH), "// auth\n");
    expect(bash(`node ${AUTH} --repo a/b check`, repo).reason).toMatch(/not tracked/);
  });
  test("a copy outside any checkout goes to a person", () => {
    const d = bash(`node ${posix(join(outside, "app-auth.mjs"))} --repo a/b check`, outside);
    expect(d.decision).toBe("human");
    expect(d.reason).toMatch(/not inside a Git checkout/);
  });
  test.skipIf(process.platform === "win32")("a symlink to the helper goes to a person", () => {
    const link = join(outside, "linked");
    mkdirSync(link);
    symlinkSync(join(worktree, AUTH), join(link, "app-auth.mjs"));
    expect(
      bash(`node ${posix(join(link, "app-auth.mjs"))} --repo a/b check`, outside).reason,
    ).toMatch(/symlink/);
  });
  test("an environment prefix, a wrapper or piped input goes to a person", () => {
    for (const command of [
      `CODE_REVIEW_APP_VAULT=x node ${AUTH} --repo a/b check`,
      `env node ${AUTH} --repo a/b check`,
      `echo x | node ${AUTH} --repo a/b check`,
    ])
      expect(bash(command).decision).toBe("human");
  });
  test("a file argument still gets the read check", () => {
    expect(
      bash(`node ${AUTH} --repo a/b gh api repos/a/b/pulls/7/reviews --input ~/.ssh/id_rsa`)
        .category,
    ).toBe("sensitive");
  });
  test("another script in the same command is still judged", () => {
    expect(bash(`node ${AUTH} --repo a/b check && rm -rf ~/x`).decision).toBe("human");
  });
  test.each([
    [
      "an unquoted pattern in <text>",
      `node ${STATUS} fail --repo a/b --pr 1 --head ${SHA} --reason * --as-app`,
    ],
    [
      "a pattern in <file>",
      `node ${AUTH} --repo a/b gh api repos/a/b/pulls/7/reviews --input .en?`,
    ],
    [
      "a class in <file>",
      `node ${AUTH} --repo a/b gh api repos/a/b/pulls/7/reviews --input '.e[n]v'`,
    ],
    [
      "a tilde in <file>",
      `node ${AUTH} --repo a/b gh api repos/a/b/pulls/7/reviews --input ~/x.json`,
    ],
    [
      "a tilde in <text>",
      `node ${STATUS} fail --repo a/b --pr 1 --head ${SHA} --reason ~ --as-app`,
    ],
    ["a .. repo", `node ${AUTH} --repo ../x check`],
    ["a ../.. repo", `node ${AUTH} --repo ../.. check`],
    ["an input redirect", `node ${STATUS} start --repo a/b --pr 1 --head ${SHA} --as-app < x.json`],
    [
      "/dev/stdin as a file",
      `node ${AUTH} --repo a/b gh api repos/a/b/pulls/7/reviews --input /dev/stdin`,
    ],
    [
      "a file outside the checkout and temp",
      `node ${AUTH} --repo a/b gh api repos/a/b/pulls/7/reviews --input /etc/passwd`,
    ],
  ])("%s goes to a person", (_name, command) => {
    expect(bash(command).decision).toBe("human");
  });
  test("a quoted pattern is one literal argument", () => {
    expect(
      bash(`node ${STATUS} fail --repo a/b --pr 1 --head ${SHA} --reason '* why?' --as-app`)
        .decision,
    ).toBe("approve");
  });
  test("a file in the working checkout may be sent", () => {
    writeFileSync(join(worktree, "body.md"), "x");
    expect(
      bash(`node ${AUTH} --repo a/b gh pr review 7 -R a/b --comment --body-file body.md`).decision,
    ).toBe("approve");
  });
  test("without the profile entry nothing changes for other scripts", () => {
    const plain = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
    expect(
      bash(`node ${AUTH} --repo a/b check`, worktree, plain).credentialHelpers,
    ).toBeUndefined();
  });
});

describe("remote-tracking refs stay evidence of the remote", () => {
  test.each([
    "git update-ref refs/remotes/origin/main HEAD",
    "git update-ref --stdin",
    "git fetch origin +pull/82/head:refs/remotes/origin/main",
    "git fetch origin feat/a:refs/remotes/origin/main",
    "git fetch . HEAD:refs/remotes/origin/main",
    "git fetch ../other main",
    "git fetch file:///tmp/x main",
    "git fetch /tmp/x",
    "git fetch origin --refmap=+refs/heads/*:refs/remotes/origin/*",
    "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/feat",
    "git push . HEAD:refs/remotes/origin/main",
    "git push ../other HEAD:main",
  ])("%s goes to a person", (command) => {
    expect(bash(command).decision).toBe("human");
  });
  test.each([
    "git fetch origin",
    "git fetch origin main",
    "git fetch origin +pull/82/head:pr82",
    "git fetch origin main:refs/remotes/origin/main",
    "git symbolic-ref --short refs/remotes/origin/HEAD",
    "git update-ref refs/heads/topic HEAD",
  ])("%s stays approved", (command) => {
    expect(bash(command).decision).toBe("approve");
  });
  test("editing the helper, committing and moving origin/main does not make it trusted", () => {
    const d = bash(
      [
        `printf x >> ${AUTH}`,
        `git commit -qam edit`,
        "git update-ref refs/remotes/origin/main HEAD",
        `node ${AUTH} --repo a/b check`,
      ].join(" && "),
    );
    expect(d.decision).toBe("human");
  });
});

describe("credentialHelpers profile field", () => {
  test.each([
    [{ path: "/abs/x.mjs", args: [["a"]] }],
    [{ path: "a/../x.mjs", args: [["a"]] }],
    [{ path: "x.mjs", args: [] }],
    [{ path: "x.mjs", args: [["<nope>"]] }],
    [{ path: "x.mjs", args: [["<int><int>"]] }],
    [{ path: "x.mjs", args: [["a<text>"]] }],
    [{ path: "x.mjs", args: [["a"]], extra: 1 }],
    [{ path: "x.mjs", args: [[[]]] }],
  ])("an invalid entry makes the profile invalid: %j", (entry) => {
    expect(() =>
      parseProfile(JSON.stringify({ version: 1, mode: "permissive", credentialHelpers: [entry] })),
    ).toThrow(ProfileError);
  });
  test("the strict profile ignores helpers", () => {
    const strict = parseProfile(
      JSON.stringify({ version: 1, mode: "strict", credentialHelpers: helpers }),
    );
    expect(strict.credentialHelpers).toEqual([]);
  });
  test("placeholders match whole values only", () => {
    const helper = { path: "x.mjs", args: [["repos/<repo>/pulls/<int>/reviews"]] };
    expect(matchShape(helper, ["repos/a/b/pulls/7/reviews"])?.index).toBe(0);
    expect(matchShape(helper, ["repos/a/b/c/pulls/7/reviews"])).toBeUndefined();
    expect(matchShape(helper, ["repos/a/b/pulls/7/reviews/1"])).toBeUndefined();
  });
});

describe("session scope wording", () => {
  test("a protected file is written to, a protected directory under", () => {
    const directory = join(root, "session");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(worktree, "AGENTS.md"), "x");
    const s = new PolicySession(directory, "codex", "s1", profile);
    const shell = (command: string): Request => ({
      sessionId: "s1",
      harness: "codex",
      cwd: worktree,
      tool: "exec_command",
      input: { command },
    });
    const file = s.review(shell("printf x >> AGENTS.md"), undefined, "PreToolUse");
    expect(file.sessionScopeLabel).toMatch(/^writes to .*AGENTS\.md$/);
    const dir = s.review(shell("printf x >> .agent-config/README.md"), undefined, "PreToolUse");
    expect(dir.sessionScopeLabel).toMatch(/^writes under .*\.agent-config$/);
  });
});
