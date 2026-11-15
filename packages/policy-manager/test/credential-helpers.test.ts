import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { matchShape, normalizeRemote, sameContent } from "../src/helpers.js";
import { evaluate } from "../src/policy.js";
import { ProfileError, parseProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import type { Decision, Request } from "../src/types.js";

const STATUS = ".agent-config/skills/review-bot/post-status.mjs";
const AUTH = ".agent-config/skills/review-bot/bot-auth.mjs";
const SHA = "38fdd662fe6810766469c1e580588f946299cecf";
const GITHUB = "https://github.com/example-org/example-repo.git";
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
    remotes: ["github.com/example-org/"],
  },
  {
    path: AUTH,
    remotes: ["github.com/example-org/"],
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

/** Passes an approval; otherwise fails with the decision's reason, so CI logs say why. */
function approved(d: Decision): boolean {
  if (d.decision !== "approve") throw new Error(`${d.decision} (${d.category}): ${d.reason}`);
  return true;
}
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "RUNNER~1-helpers-")));
  const source = join(root, "source");
  execFileSync("git", ["init", "-b", "main", source], { stdio: "ignore" });
  mkdirSync(join(source, ".agent-config", "skills", "review-bot"), { recursive: true });
  writeFileSync(join(source, STATUS), "// status\n");
  writeFileSync(join(source, AUTH), "// auth\n");
  git(source, "add", ".");
  git(source, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "helpers");
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", source, clone], { stdio: "ignore" });
  git(clone, "config", "remote.origin.url", GITHUB);
  worktree = join(clone, ".worktrees", "feat");
  git(clone, "worktree", "add", "-b", "feat/a", worktree);
  changed = join(clone, ".worktrees", "changed");
  git(clone, "worktree", "add", "-b", "feat/b", changed);
  appendFileSync(join(changed, AUTH), "console.log('extra');\n");
  outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "bot-auth.mjs"), "// auth\n");
  rw = join(root, "rw");
  mkdirSync(rw);
  writeFileSync(join(rw, "review.json"), "{}");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
/** A fresh clone of the helpers repository, for tests that change refs or files. */
function clone(name: string, github = true): string {
  const repo = join(root, name);
  execFileSync("git", ["clone", "-q", join(root, "source"), repo], { stdio: "ignore" });
  if (github) git(repo, "config", "remote.origin.url", GITHUB);
  return repo;
}

describe("credential helpers", () => {
  test("a listed helper with an accepted shape is approved and named", () => {
    const d = bash(
      `node ${STATUS} start --repo example-org/example-repo --pr 82 --head ${SHA} --as-app`,
    );
    expect(d).toSatisfy(approved);
    expect(d.reason).toBe("Listed credential helper");
    expect(d.credentialHelpers).toEqual([`${STATUS}#0`]);
  });
  test("by absolute path, with a file argument and a placeholder inside a word", () => {
    const d = bash(
      `node ${posix(join(worktree, AUTH))} --repo a/b gh api repos/a/b/pulls/7/reviews --input ${posix(join(rw, "review.json"))}`,
    );
    expect(d).toSatisfy(approved);
    expect(d.credentialHelpers).toEqual([`${AUTH}#1`]);
    expect(
      bash(
        `node ${AUTH} --repo a/b gh pr review 7 -R a/b --comment --body-file ${posix(join(rw, "review.json"))}`,
      ),
    ).toSatisfy(approved);
  });
  test("works inside the reviewer's compound script, and git reads stay symlink-free", () => {
    const script = [
      `cd ${posix(worktree)} && N=82 REPO=example-org/example-repo; RW=${posix(rw)}/82; mkdir -p $RW`,
      `node ${STATUS} start --repo $REPO --pr $N --head ${SHA} --as-app`,
      `git fetch origin "+pull/$N/head:pr$N" && git fetch origin main && git rev-parse pr$N`,
      "git diff --name-only origin/main...pr$N | tee $RW/files.txt",
      "git diff origin/main...pr$N",
    ].join("\n");
    const d = bash(script);
    expect(d.reason).not.toMatch(/symlink/);
    expect(d).toSatisfy(approved);
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
    mkdirSync(join(repo, ".agent-config", "skills", "review-bot"), { recursive: true });
    writeFileSync(join(repo, AUTH), "// auth\n");
    expect(bash(`node ${AUTH} --repo a/b check`, repo).reason).toMatch(/not tracked/);
  });
  test("a copy outside any checkout goes to a person", () => {
    const d = bash(`node ${posix(join(outside, "bot-auth.mjs"))} --repo a/b check`, outside);
    expect(d.decision).toBe("human");
    expect(d.reason).toMatch(/not inside a Git checkout/);
  });
  test.skipIf(process.platform === "win32")("a symlink to the helper goes to a person", () => {
    const link = join(outside, "linked");
    mkdirSync(link);
    symlinkSync(join(worktree, AUTH), join(link, "bot-auth.mjs"));
    expect(
      bash(`node ${posix(join(link, "bot-auth.mjs"))} --repo a/b check`, outside).reason,
    ).toMatch(/symlink/);
  });
  test("an environment prefix, a wrapper or piped input goes to a person", () => {
    for (const command of [
      `HELPER_TOKEN=x node ${AUTH} --repo a/b check`,
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
      bash(`node ${STATUS} fail --repo a/b --pr 1 --head ${SHA} --reason '* why?' --as-app`),
    ).toSatisfy(approved);
  });
  test("a file in the working checkout may be sent", () => {
    writeFileSync(join(worktree, "body.md"), "x");
    expect(
      bash(`node ${AUTH} --repo a/b gh pr review 7 -R a/b --comment --body-file body.md`),
    ).toSatisfy(approved);
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
    expect(bash(command)).toSatisfy(approved);
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
  test.each([
    "git symbolic-ref HEAD refs/remotes/origin/main",
    "git symbolic-ref refs/heads/foo refs/remotes/origin/main",
    "git symbolic-ref -d refs/remotes/origin/HEAD",
    "git update-ref refs/replace/0123456789abcdef0123456789abcdef01234567 HEAD",
    "git update-ref HEAD HEAD~1",
    "git update-ref --no-deref refs/heads/topic HEAD",
    "git update-ref origin/main HEAD",
  ])("%s goes to a person", (command) => {
    expect(bash(command).decision).toBe("human");
  });
  test("update-ref through a symbolic branch goes to a person", () => {
    const repo = clone("symref");
    git(repo, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
    expect(bash("git update-ref refs/heads/alias HEAD", repo).reason).toMatch(/symbolic ref/);
  });
  test("chain: point HEAD at origin/main, then commit an edited helper", () => {
    const d = bash(
      [
        "git symbolic-ref HEAD refs/remotes/origin/main",
        `printf x >> ${AUTH}`,
        "git commit -qam edit",
        `node ${AUTH} --repo a/b check`,
      ].join(" && "),
    );
    expect(d.decision).toBe("human");
  });
  test.each([
    ["a tag", ["tag", "origin/HEAD", "HEAD"]],
    ["a branch", ["branch", "origin/HEAD", "HEAD"]],
    ["a tag for main", ["tag", "origin/main", "HEAD"]],
  ])("shadowing origin with %s does not trust an edited, committed helper", (_name, shadow) => {
    const repo = clone(`shadow-${shadow[0]}-${shadow[1]?.replace("/", "-")}`);
    appendFileSync(join(repo, AUTH), "console.log('edited');\n");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "edit");
    git(repo, ...shadow);
    if (shadow[1] === "origin/main") git(repo, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
    expect(bash(`node ${AUTH} --repo a/b check`, repo).reason).toMatch(/differs/);
  });
  test("a replace ref cannot change the committed helper that is read", () => {
    const repo = clone("replace");
    const blob = (rev: string) =>
      execFileSync("git", ["-C", repo, "rev-parse", rev], { encoding: "utf8" }).trim();
    const original = blob(`refs/remotes/origin/main:${AUTH}`);
    appendFileSync(join(repo, AUTH), "console.log('edited');\n");
    const edited = execFileSync("git", ["-C", repo, "hash-object", "-w", AUTH], {
      encoding: "utf8",
    }).trim();
    git(repo, "replace", original, edited);
    expect(bash(`node ${AUTH} --repo a/b check`, repo).reason).toMatch(/differs/);
    expect(bash(`git update-ref refs/replace/${original} ${edited}`, repo).decision).toBe("human");
  });
  test.each([
    ".git/refs/remotes/origin/main",
    ".git/packed-refs",
    ".git/HEAD",
    ".git/info/grafts",
    ".git/worktrees/feat/HEAD",
  ])("a direct write to %s is refused", (path) => {
    const main = join(worktree, "..", "..");
    expect(bash(`printf x > ${posix(join(main, path))}`).decision).toBe("human");
    const write = evaluate(
      {
        sessionId: "t",
        harness: "claude",
        cwd: worktree,
        tool: "Write",
        input: { file_path: join(main, path), content: "x" },
      },
      undefined,
      profile,
    );
    expect(write.decision).toBe("human");
  });
});

describe("the helper's checkout must come from a listed remote", () => {
  test("a clone of a local repository is refused, by absolute path and as cwd", () => {
    const evil = clone("evil-local", false);
    expect(bash(`node ${posix(join(evil, AUTH))} --repo a/b check`).reason).toMatch(
      /listed remote/,
    );
    expect(bash(`node ${AUTH} --repo a/b check`, evil).reason).toMatch(/listed remote/);
  });
  test("an origin under another owner is refused", () => {
    const repo = clone("other-owner");
    git(repo, "config", "remote.origin.url", "git@github.com:someone/example-repo.git");
    expect(bash(`node ${AUTH} --repo a/b check`, repo).reason).toMatch(/listed remote/);
  });
  test("an ssh origin under the listed owner is accepted", () => {
    const repo = clone("ssh-origin");
    git(repo, "config", "remote.origin.url", "git@GitHub.com:example-org/example-repo.git");
    expect(bash(`node ${AUTH} --repo a/b check`, repo)).toSatisfy(approved);
  });
  test("a URL rewrite or a push URL is refused", () => {
    const rewrite = clone("insteadof");
    git(rewrite, "config", "url.file:///tmp/evil/.insteadOf", "https://github.com/");
    expect(bash(`node ${AUTH} --repo a/b check`, rewrite).reason).toMatch(/listed remote/);
    const push = clone("pushurl");
    git(push, "config", "remote.origin.pushurl", "file:///tmp/evil");
    expect(bash(`node ${AUTH} --repo a/b check`, push).reason).toMatch(/listed remote/);
  });
  test.each([
    "git remote add origin https://github.com/example-org/x.git",
    "git remote add upstream https://github.com/example-org/x.git",
    "git remote set-url origin https://github.com/example-org/x.git",
    "git remote rename origin old",
    "git remote set-branches origin main",
    "git config remote.origin.url https://github.com/example-org/x.git",
    "git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*",
    "git config url.file:///tmp/x/.insteadOf https://github.com/",
    "git config include.path /tmp/x",
    "git config includeIf.gitdir:/x.path /tmp/x",
    "git clone -c remote.origin.url=x /tmp/evil x",
    "git clone --config=remote.origin.url=x /tmp/evil x",
    "git clone --origin origin2 https://github.com/example-org/x.git y",
    "git clone -o origin2 https://github.com/example-org/x.git y",
    "git clone --template=/tmp/t https://github.com/example-org/x.git y",
    "git clone --separate-git-dir /tmp/g https://github.com/example-org/x.git y",
    "git init --template=/tmp/t y",
    "git init --separate-git-dir /tmp/g y",
    "git fetch origin pull/1/head:remotes/origin/main",
  ])("%s goes to a person", (command) => {
    expect(bash(command).decision).toBe("human");
  });
  test.each([".git/config", ".git/worktrees/feat/config", ".git/config.worktree"])(
    "a direct write to %s is refused",
    (path) => {
      const main = join(worktree, "..", "..");
      expect(bash(`printf x >> ${posix(join(main, path))}`).decision).toBe("human");
    },
  );
  test("a fresh clone from the listed remote stays fetchable", () => {
    expect(bash("git clone https://github.com/example-org/example-repo.git ac")).toMatchObject({
      decision: "approve",
    });
    expect(bash("git fetch origin")).toSatisfy(approved);
  });
  test("normalizeRemote", () => {
    expect(normalizeRemote("https://github.com/Example-Org/Example-Repo.git/")).toBe(
      "github.com/example-org/example-repo",
    );
    expect(normalizeRemote("ssh://git@github.com:22/example-org/x")).toBe(
      "github.com/example-org/x",
    );
    expect(normalizeRemote("git@github.com:example-org/x.git")).toBe("github.com/example-org/x");
    for (const local of ["/tmp/x", "file:///tmp/x", "../x", "C:/x", "https://github.com/../x"])
      expect(normalizeRemote(local)).toBeUndefined();
  });
});

describe("Windows short names", () => {
  test("a ~ after a letter or digit is literal in a variable value and a file argument", () => {
    const short = posix(join(rw, "X~1"));
    expect(bash(`R=${short}; mkdir -p $R && printf x > $R/a.txt`)).toSatisfy(approved);
    expect(
      bash(
        `node ${AUTH} --repo a/b gh api repos/a/b/pulls/7/reviews --input ${posix(join(rw, "review.json"))}`,
      ),
    ).toSatisfy(approved);
  });
  test.each(["R=~/x; printf x > $R/a", "R=/tmp:~/x; printf x > $R/a"])(
    "a ~ the shell expands keeps the value unknown: %s",
    (command) => {
      expect(bash(command).decision).toBe("human");
    },
  );
  test("a file argument with an expanded ~ is refused", () => {
    expect(
      bash(`node ${AUTH} --repo a/b gh api repos/a/b/pulls/7/reviews --input x:~/y`).decision,
    ).toBe("human");
  });
});

describe("line endings", () => {
  test("a CRLF checkout of an LF helper matches", () => {
    const repo = clone("crlf");
    const file = join(repo, AUTH);
    writeFileSync(file, readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n"));
    expect(bash(`node ${AUTH} --repo a/b check`, repo)).toSatisfy(approved);
  });
  test("a helper committed with CR must match byte for byte", () => {
    const source = join(root, "cr-source");
    execFileSync("git", ["init", "-q", "-b", "main", source], { stdio: "ignore" });
    git(source, "config", "core.autocrlf", "false");
    mkdirSync(join(source, ".agent-config", "skills", "review-bot"), { recursive: true });
    writeFileSync(join(source, AUTH), "// auth\r\nmore\r\n");
    git(source, "add", ".");
    git(source, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "cr");
    const repo = join(root, "cr-clone");
    execFileSync("git", ["-c", "core.autocrlf=false", "clone", "-q", source, repo], {
      stdio: "ignore",
    });
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "remote.origin.url", GITHUB);
    expect(bash(`node ${AUTH} --repo a/b check`, repo)).toSatisfy(approved);
    writeFileSync(join(repo, AUTH), "// auth\nmore\n");
    expect(bash(`node ${AUTH} --repo a/b check`, repo).reason).toMatch(/differs/);
  });
  test("sameContent", () => {
    const b = (s: string) => Buffer.from(s, "latin1");
    expect(sameContent(b("a\r\nb\r\n"), b("a\nb\n"))).toBe(true);
    expect(sameContent(b("a\r\nb\r\n"), b("a\r\nb\r\n"))).toBe(true);
    expect(sameContent(b("a\nb\n"), b("a\r\nb\r\n"))).toBe(false);
    expect(sameContent(b("a\r\nb\n"), b("a\r\nb\r\n"))).toBe(false);
    expect(sameContent(b("a\r\nc\r\n"), b("a\nb\n"))).toBe(false);
  });
});

describe("credentialHelpers profile field", () => {
  test.each([
    [{ path: "/abs/x.mjs", args: [["a"]], remotes: ["github.com/o/"] }],
    [{ path: "a/../x.mjs", args: [["a"]], remotes: ["github.com/o/"] }],
    [{ path: "x.mjs", args: [], remotes: ["github.com/o/"] }],
    [{ path: "x.mjs", args: [["<nope>"]], remotes: ["github.com/o/"] }],
    [{ path: "x.mjs", args: [["<int><int>"]], remotes: ["github.com/o/"] }],
    [{ path: "x.mjs", args: [["a<text>"]], remotes: ["github.com/o/"] }],
    [{ path: "x.mjs", args: [["a"]], remotes: ["github.com/o/"], extra: 1 }],
    [{ path: "x.mjs", args: [[[]]], remotes: ["github.com/o/"] }],
    [{ path: "x.mjs", args: [["a"]] }],
    [{ path: "x.mjs", args: [["a"]], remotes: [] }],
    [{ path: "x.mjs", args: [["a"]], remotes: ["GitHub.com/o/"] }],
    [{ path: "x.mjs", args: [["a"]], remotes: ["github.com"] }],
    [{ path: "x.mjs", args: [["a"]], remotes: ["https://github.com/o/"] }],
    [{ path: "x.mjs", args: [["a"]], remotes: ["github.com/../"] }],
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
    const helper = { path: "x.mjs", args: [["repos/<repo>/pulls/<int>/reviews"]], remotes: [] };
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
