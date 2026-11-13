import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { evaluate } from "../src/policy.js";
import { parseProfile, strictProfile } from "../src/profile.js";
import type { Request } from "../src/types.js";

/**
 * A session started in one repository (its main checkout) may write to another repository, as long
 * as the writes land in a linked feature worktree. The main checkout of either repository stays
 * protected. The rule is the same for every harness.
 */
let root: string, session: string, repo: string, wt: string;
const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
const HARNESSES = ["claude", "codex", "copilot"] as const;
const posix = (path: string) => path.replace(/\\/g, "/");

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function decide(
  command: string,
  harness: Request["harness"] = "claude",
  cwd = session,
  profile = permissive,
) {
  return evaluate({ sessionId: "t", harness, cwd, tool: "Bash", input: { command } }, undefined, {
    ...profile,
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cross-repo-"));
  const origin = join(root, "origin.git");
  session = join(root, "session");
  repo = join(root, "repo");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", origin, repo], { stdio: "ignore" });
  for (const dir of [repo]) {
    git(dir, ["config", "user.name", "T"]);
    git(dir, ["config", "user.email", "t@example.com"]);
  }
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-m", "init"]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(repo, ["fetch", "origin"]);
  wt = join(repo, ".worktrees", "feat");
  git(repo, ["worktree", "add", "-b", "feat/x", wt, "origin/main"]);
  mkdirSync(join(wt, "pkg", "test"), { recursive: true });
  mkdirSync(join(wt, ".changeset"));
  mkdirSync(session);
  git(session, ["init", "-b", "main"]);
  writeFileSync(join(session, "s.txt"), "s");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("writes after `cd` into another repository's linked worktree", () => {
  // The session cwd is a main checkout. `cd X && write` only writes if the `cd` succeeded, so it
  // is judged in X alone; the session cwd is not a possible directory for it.
  const approved = () => [
    `cd ${posix(wt)} && printf -- 'x' > .changeset/x.md`,
    `cd ${posix(wt)}/pkg && cat >> test/x.test.ts <<'EOF'\na\nEOF`,
    `cd ${posix(wt)} && sed -i.bak 's/a/b/' a.txt`,
    `cd ${posix(wt)} && ls && echo x > a.txt`,
    `cd ${posix(wt)} && cd pkg && echo x > test/y.ts`,
    `cd ${posix(wt)} && { echo x > a.txt; }`,
    `cd ${posix(wt)} && (echo x > a.txt)`,
    `{ cd ${posix(wt)}; } && echo x > a.txt`,
    `if cd ${posix(wt)}; then echo x > a.txt; fi`,
    `cd ${posix(wt)} && git add -A && git commit -m x && git push -u origin HEAD && gh pr create --fill`,
  ];
  test.each(HARNESSES)("%s approves them", (harness) => {
    for (const command of approved())
      expect(decide(command, harness).decision, command).toBe("approve");
  });

  // Adversarial: every form where the write can run in the session's main checkout, or in the
  // other repository's main checkout.
  const refused = () => [
    `cd ${posix(wt)}; echo x > a.txt`,
    `cd ${posix(wt)}\necho x > a.txt`,
    `cd ${posix(wt)} || echo x > a.txt`,
    `cd ${posix(wt)} && ls || echo x > a.txt`,
    `cd ${posix(wt)} || cd ${posix(wt)} && echo x > a.txt`,
    `cd ${posix(wt)} && echo ok > a.txt; echo x > s.txt`,
    `cd ${posix(wt)} & echo x > a.txt`,
    `! cd ${posix(wt)} && echo x > a.txt`,
    `{ cd ${posix(wt)}; true; } && echo x > a.txt`,
    `if cd ${posix(wt)}; then :; fi && echo x > a.txt`,
    `if false; then :; elif cd ${posix(wt)}; then :; else :; fi; echo x > a.txt`,
    `(cd ${posix(wt)}) && echo x > a.txt`,
    `cd ${posix(wt)} && cd ${posix(repo)} && echo x > a.txt`,
    `cd ${posix(repo)} && echo x > a.txt`,
    `cd ${posix(wt)} && cd ../.. && echo x > a.txt`,
    `{ cd ${posix(wt)} && ls; } > s.txt`,
    `cd ${posix(wt)} && ls; cat <<'EOF' > s.txt\nx\nEOF`,
  ];
  test.each(HARNESSES)("%s sends the unsafe forms to a human", (harness) => {
    for (const command of refused())
      expect(decide(command, harness).decision, command).toBe("human");
  });
});

describe("Git from another repository's main clone", () => {
  test.each(HARNESSES)("%s approves fetch and new worktrees under the two worktree roots", (h) => {
    for (const command of [
      `git -C ${posix(repo)} fetch origin`,
      `cd ${posix(repo)} && git fetch origin`,
      `git -C ${posix(repo)} worktree add .worktrees/new -b feat/new origin/main`,
      `git -C ${posix(repo)} worktree add --no-track .worktrees/new -b feat/new origin/main`,
      `git -C ${posix(repo)} worktree add .claude/worktrees/new -b feat/new origin/main`,
      `cd ${posix(repo)} && git worktree add -b feat/new .worktrees/new origin/main`,
      `git -C ${posix(repo)} worktree add ${posix(root)}/elsewhere -b feat/new origin/main`,
      `git -C ${posix(wt)} worktree add ${posix(repo)}/.worktrees/sibling -b feat/s origin/main`,
    ])
      expect(decide(command, h).decision, command).toBe("approve");
  });
  test.each(HARNESSES)("%s keeps the main working tree protected", (h) => {
    for (const command of [
      `git -C ${posix(repo)} worktree add src/inside -b feat/new origin/main`,
      `git -C ${posix(repo)} worktree add .worktrees -b feat/new origin/main`,
      `git -C ${posix(repo)} worktree add .worktrees/../src -b feat/new origin/main`,
      `git -C ${posix(repo)} worktree add .claude/other -b feat/new origin/main`,
      `git -C ${posix(wt)} worktree add ../../src -b feat/new origin/main`,
      `git -C ${posix(repo)} worktree add -B main .worktrees/new origin/main`,
      `cd ${posix(repo)} && echo x > a.txt`,
    ])
      expect(decide(command, h).decision, command).toBe("human");
  });

  test("the strict profile approves the same worktree forms and nothing looser", () => {
    git(repo, ["remote", "set-url", "origin", "https://github.com/example/repository.git"]);
    try {
      const strict = (command: string) => decide(command, "codex", repo, strictProfile).decision;
      expect(strict("git fetch origin")).toBe("approve");
      expect(strict("git worktree add .worktrees/s1 -b feat/s1 origin/main")).toBe("approve");
      expect(strict("git worktree add --no-track .worktrees/s1 -b feat/s1 origin/main")).toBe(
        "approve",
      );
      expect(strict("git worktree add -b feat/s1 .claude/worktrees/s1 origin/main")).toBe(
        "approve",
      );
      expect(
        strict(
          `git -C ${posix(wt)} worktree add ${posix(repo)}/.worktrees/s2 -b feat/s2 origin/main`,
        ),
      ).toBe("approve");
      for (const command of [
        "git worktree add src/s1 -b feat/s1 origin/main",
        "git worktree add .worktrees/s1 -b main origin/main",
        "git worktree add .worktrees/feat -b feat/s1 origin/main",
        "git worktree add .worktrees/s1 -b feat/s1 origin/other",
        "git worktree add .worktrees/s1 -B feat/s1 origin/main",
        "git worktree add .worktrees/s1 -b feat/s1 --force origin/main",
        "git worktree add .claude/s1 -b feat/s1 origin/main",
      ])
        expect(strict(command), command).toBe("human");
    } finally {
      git(repo, ["remote", "set-url", "origin", join(root, "origin.git")]);
    }
  });
});

describe("Write tools into another repository", () => {
  test.each(HARNESSES)("%s: a linked worktree is approved; a main checkout is not", (harness) => {
    const write = (file_path: string) =>
      evaluate(
        {
          sessionId: "t",
          harness,
          cwd: session,
          tool: "Write",
          input: { file_path, content: "x" },
        },
        undefined,
        permissive,
      ).decision;
    expect(write(join(wt, "pkg", "new.ts"))).toBe("approve");
    expect(write(join(repo, "new.ts"))).toBe("human");
    expect(write(join(session, "new.ts"))).toBe("human");
  });
});
