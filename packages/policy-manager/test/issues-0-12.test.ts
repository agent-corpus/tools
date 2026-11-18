import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { scriptRules } from "../src/hard.js";
import { evaluate, requestHash } from "../src/policy.js";
import { parseProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

// Issues #38, #40, #48 and #53, and the review nits folded into 0.12.0.
const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
let root: string,
  repo: string,
  wt: string,
  counter = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "ignore",
  });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "issues-012-")));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "tool.mjs"), "console.log('ok')\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "remote", "set-head", "origin", "main");
  wt = join(repo, ".worktrees", "feat");
  git(repo, "worktree", "add", "-q", "-b", "feat/x", wt);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const bash = (command: string, cwd = wt): Request => ({
  sessionId: "s1",
  harness: "claude",
  cwd,
  tool: "Bash",
  input: { command },
});
const tool = (name: string, input: Record<string, unknown>, cwd = wt): Request => ({
  sessionId: "s1",
  harness: "claude",
  cwd,
  tool: name,
  input,
});
async function decide(request: Request) {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  let classified = false;
  const s = new PolicySession(directory, "claude", "s1", permissive, undefined, {
    classify: async (cli) => {
      classified = true;
      return { ok: false, cli, model: "m", reason: "missing" as const, latencyMs: 0 };
    },
    nativeRules: () => undefined,
  });
  const d = await s.decide(request, "PreToolUse");
  return d.decision === "approve"
    ? classified
      ? "AI"
      : "eng"
    : (d.hard ?? (classified ? "classified" : d.decision));
}

describe("#38 credential file names", () => {
  const names = [
    "client_secret_123.apps.googleusercontent.com.json",
    "AuthKey_ABC.p8",
    "release.jks",
    "app.keystore",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_ecdsa_sk",
    "server.ppk",
  ];
  test.each(names)("Read and cat of %s are credential reads", async (name) => {
    expect(await decide(tool("Read", { file_path: join(wt, name) }))).toBe("credential-read");
    expect(await decide(bash(`cat ${name}`))).toBe("credential-read");
    expect(await decide(bash(`cp ${name} /tmp/x`))).toBe("credential-read");
  });
  test.each(["client_secret_parser.ts", "keystore.ts", "p8.md", "id_dsa.md", "ppk-notes.txt"])(
    "a source file with a similar name is not: %s",
    async (name) => {
      expect(await decide(tool("Read", { file_path: join(wt, name) }))).not.toBe("credential-read");
    },
  );
});

describe("#40 file tool hashes and scratchpad writes", () => {
  test("an absolute path hashes the same from any cwd, and without bookkeeping fields", () => {
    const write = (cwd: string, extra = {}) =>
      tool("Write", { file_path: "/tmp/x/a.md", content: "x", ...extra }, cwd);
    expect(requestHash(write("/a"))).toBe(requestHash(write("/b")));
    expect(requestHash(write("/a"))).toBe(requestHash(write("/a", { description: "d" })));
    expect(requestHash(write("/a"))).not.toBe(
      requestHash(tool("Write", { file_path: "/tmp/x/b.md", content: "x" }, "/a")),
    );
    const relative = (cwd: string) => tool("Write", { file_path: "a.md", content: "x" }, cwd);
    expect(requestHash(relative("/a"))).not.toBe(requestHash(relative("/b")));
  });
  test("a Write into a scratchpad folder that does not exist yet is temp-write", () => {
    const path = join(tmpdir(), "claude-501", "-p", "sess", "scratchpad", "merge-ready", "80.md");
    const d = evaluate(
      tool("Write", { file_path: path, content: "x" }, "/"),
      undefined,
      permissive,
    );
    expect(d.decision).toBe("approve");
    expect(d.category).toBe("temp-write");
  });
});

describe.skipIf(process.platform === "win32")("#48 scripts run in a worktree", () => {
  test("the committed default-branch script runs without review", async () => {
    expect(await decide(bash("node tool.mjs"))).toBe("eng");
  });
  test("an edited, untracked or not yet written script goes to the classifier", async () => {
    writeFileSync(join(wt, "new.mjs"), "console.log(1)\n");
    expect(await decide(bash("node new.mjs"))).not.toBe("eng");
    writeFileSync(join(wt, "tool.mjs"), "console.log('changed')\n");
    try {
      expect(await decide(bash("node tool.mjs"))).not.toBe("eng");
    } finally {
      git(wt, "checkout", "--", "tool.mjs");
    }
    expect(await decide(bash("python3 later.py"))).not.toBe("eng");
  });
});

describe("#53 interpreter code that hides a call", () => {
  test.each([
    `node -e "require('fs')['rm'+'Sync']('x')"`,
    `python3 -c "import os; getattr(os, 'rem'+'ove')('x')"`,
    `python3 -c "from os import remove as r; r('x')"`,
    `python3 -c "import os; f = os.remove; f('x')"`,
    `ruby -e "File.public_send(:delete, 'x')"`,
    `perl -e "my \\$f = \\\\&CORE::unlink; &\\$f('x')"`,
    `php -r '$f = "unlink"; $f("x");'`,
  ])("is not engine-approved: %s", async (command) => {
    expect(await decide(bash(command))).not.toBe("eng");
  });
  test("an indirect call that names the state is policy-state", () => {
    const state = join(tmpdir(), `acp-${process.getuid?.() ?? "user"}-0123456789abcdef01234567`);
    expect([
      ...scriptRules(`node -e "require('fs')['rm'+'Sync']('${state}/grants.json')"`, wt),
    ]).toContain("policy-state");
  });
  test.each([
    "gh project delete 1 --owner example-org",
    "gh project item-delete 1 --owner example-org --id x",
    "gh repo autolink delete 1",
  ])("gh %s is on the floor", (command) =>
    expect([...scriptRules(command, wt)]).toContain("repo-delete"),
  );
});

describe("review nits", () => {
  test.each([
    "echo 'proxy = http://x' >> ~/.curlrc",
    "echo x > ~/.config/curl/curlrc",
    "echo x >> ~/.gitconfig",
    "echo x >> ~/.npmrc",
    "echo x >> ~/.netrc",
    "echo x >> ~/.ssh/config",
  ])("writing a tool rc file is not approved: %s", async (command) => {
    expect(await decide(bash(command))).not.toBe("eng");
    expect(await decide(bash(command))).not.toBe("AI");
  });
  test("printing remote URLs is a credential read only when a URL carries one", async () => {
    const cases = ["git remote -v", "git config --get remote.origin.url", "git config -l"];
    for (const command of cases) expect(await decide(bash(command))).not.toBe("credential-read");
    git(
      repo,
      "remote",
      "set-url",
      "origin",
      "https://x-access-token:abc@github.com/example-org/r.git",
    );
    try {
      for (const command of cases) expect(await decide(bash(command))).toBe("credential-read");
    } finally {
      git(repo, "remote", "set-url", "origin", join(root, "origin.git"));
    }
  });
  test.each(["cat .git/{config,HEAD}", "cat ../../.git/config.lock", "cat ../../.git/config~"])(
    "Git config through a pattern or a backup is a credential read: %s",
    async (command) => {
      expect(await decide(bash(command))).toBe("credential-read");
    },
  );
  test("Grep and Glob on a Git directory are credential reads", async () => {
    expect(await decide(tool("Grep", { pattern: "token", path: join(repo, ".git") }))).toBe(
      "credential-read",
    );
    expect(await decide(tool("Glob", { pattern: "**/*", path: join(repo, ".git") }))).toBe(
      "credential-read",
    );
  });
  test.skipIf(process.platform === "win32")(
    "GIT_DIR and GIT_WORK_TREE naming the verified feature worktree are approved",
    async () => {
      const gitDir = execFileSync("git", ["-C", wt, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8",
      }).trim();
      expect(await decide(bash(`GIT_DIR=${gitDir} GIT_WORK_TREE=${wt} git status --short`))).toBe(
        "eng",
      );
      expect(
        await decide(bash(`export GIT_DIR=${gitDir}\nexport GIT_WORK_TREE=${wt}\ngit status`)),
      ).toBe("eng");
      expect(await decide(bash(`GIT_DIR=${join(repo, ".git")} git status`))).not.toBe("eng");
      expect(await decide(bash("export GIT_DIR=/tmp/elsewhere\ngit status"))).not.toBe("eng");
    },
  );
});
