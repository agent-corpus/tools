import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { evaluate } from "../src/policy.js";
import { parseProfile } from "../src/profile.js";
import type { Request } from "../src/types.js";

const links = process.platform !== "win32";
let root: string, repo: string, wt: string, outside: string;
const profile = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-c", "protocol.file.allow=always", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function decide(command: string, cwd = wt) {
  const r: Request = { sessionId: "t", harness: "claude", cwd, tool: "Bash", input: { command } };
  return evaluate(r, undefined, profile).decision;
}
/** Runs `change`, checks, then puts the worktree back to HEAD with the fixture's loose files. */
function scenario(change: () => void, check: () => void) {
  try {
    change();
    check();
  } finally {
    git(wt, ["reset", "-q", "--hard", "HEAD"]);
    git(wt, ["update-index", "--no-assume-unchanged", "a.txt"]);
    rmSync(join(wt, "late.txt"), { force: true });
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "recoverable-test-"));
  const origin = join(root, "origin.git");
  const subOrigin = join(root, "sub.git");
  repo = join(root, "repo");
  wt = join(root, "wt");
  outside = join(root, "outside");
  write(join(outside, "o.txt"), "outside");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", subOrigin]);
  const subSeed = join(root, "sub-seed");
  execFileSync("git", ["clone", "-q", subOrigin, subSeed], { stdio: "ignore" });
  for (const cwd of [subSeed]) {
    git(cwd, ["config", "user.name", "T"]);
    git(cwd, ["config", "user.email", "t@example.com"]);
  }
  write(join(subSeed, "s.txt"), "s");
  git(subSeed, ["add", "."]);
  git(subSeed, ["commit", "-qm", "s"]);
  git(subSeed, ["push", "-q", "origin", "main"]);

  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  git(repo, ["config", "user.name", "T"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  write(join(repo, "a.txt"), "a");
  write(join(repo, "dir", "b.txt"), "b");
  write(join(repo, "dir", "c.txt"), "c");
  write(join(repo, "mixed", "t.txt"), "t");
  write(join(repo, "ign", "kept.txt"), "kept");
  write(join(repo, ".gitignore"), "*.log\n");
  write(join(repo, ".github", "w.yml"), "w");
  if (links) {
    symlinkSync("dir", join(repo, "link"));
    symlinkSync(outside, join(repo, "outlink"));
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "one"]);
  git(repo, ["submodule", "add", "-q", subOrigin, "sub"]);
  git(repo, ["commit", "-qm", "sub"]);
  write(join(repo, "two.txt"), "2");
  git(repo, ["add", "two.txt"]);
  git(repo, ["commit", "-qm", "two"]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  git(repo, ["worktree", "add", "-q", "-b", "feature", wt]);
  git(wt, ["submodule", "update", "-q", "--init"]);
  write(join(wt, "mixed", "u.txt"), "untracked sibling");
  write(join(wt, "ign", "x.log"), "ignored");
  write(join(wt, "new.txt"), "untracked");
  if (links) symlinkSync("a.txt", join(wt, "newlink"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("recoverable rm", () => {
  test.each([
    "rm a.txt",
    "rm -f a.txt dir/b.txt",
    "rm -- a.txt",
    "rm -rf dir",
    "rm -r dir/",
    "rm -fv ./dir/b.txt",
    "rm mixed/t.txt",
    "ls && rm a.txt; echo done",
    "rm a.txt && rm -r dir",
  ])("approves %s", (command) => expect(decide(command)).toBe("approve"));

  test.each([
    "rm new.txt",
    "rm -rf mixed",
    "rm -rf ign",
    "rm ign/x.log",
    "rm -rf .",
    "rm -rf ./",
    "rm -rf ../wt",
    "rm -rf dir/..",
    "rm -rf *",
    "rm -f '*.txt'",
    "rm -f dir/?.txt",
    "rm -f 'dir/[bc].txt'",
    "rm a.txt -rf",
    "rm -- -f",
    "rm missing.txt",
    "rm -rf sub",
    "rm sub/s.txt",
    "rm .github/w.yml",
    "rm .gitignore .git/config",
    "rm -I a.txt",
    "rm --no-preserve-root -rf dir",
    "rm -P a.txt",
    "rm",
    "mv new.txt a.txt; rm a.txt",
    "cp new.txt a.txt && rm a.txt",
    "echo x > a.txt && rm a.txt",
    "bash -c 'rm a.txt'",
    "env rm a.txt",
    "A=1 rm a.txt",
    "command rm a.txt",
    "/bin/rm a.txt",
    "rm $(echo a.txt)",
    "f=a.txt; rm $f",
    "rm a.txt | cat",
    "unlink a.txt",
    "git clean -fd",
  ])("sends %s to a human", (command) => expect(decide(command)).toBe("human"));

  test("the main clone and an absolute path outside the worktree stay human", () => {
    expect(decide("rm a.txt", repo)).toBe("human");
    expect(decide(`rm ${join(repo, "a.txt")}`)).toBe("human");
    expect(decide(`rm ${join(wt, "a.txt")}`)).toBe("approve");
  });

  test("a modified, staged, or assume-unchanged file stays human", () => {
    scenario(
      () => write(join(wt, "a.txt"), "changed"),
      () => expect(decide("rm a.txt")).toBe("human"),
    );
    scenario(
      () => {
        write(join(wt, "a.txt"), "staged");
        git(wt, ["add", "a.txt"]);
        write(join(wt, "a.txt"), "a");
      },
      () => {
        expect(decide("rm a.txt")).toBe("human");
        expect(decide("git rm -f a.txt")).toBe("human");
      },
    );
    scenario(
      () => {
        git(wt, ["update-index", "--assume-unchanged", "a.txt"]);
        write(join(wt, "a.txt"), "hidden change");
      },
      () => expect(decide("rm a.txt")).toBe("human"),
    );
    scenario(
      () => write(join(wt, "dir", "b.txt"), "changed"),
      () => expect(decide("rm -rf dir")).toBe("human"),
    );
  });

  test.skipIf(!links)("symlinks are judged by what is removed", () => {
    expect(decide("rm link")).toBe("approve"); // the tracked link itself
    expect(decide("rm link/b.txt")).toBe("approve"); // resolves to dir/b.txt
    expect(decide("rm outlink")).toBe("approve");
    expect(decide("rm outlink/o.txt")).toBe("human");
    expect(decide("rm -r outlink/")).toBe("human");
    expect(decide("rm newlink")).toBe("human"); // untracked link
  });
});

describe("git rm", () => {
  test("plain git rm keeps relying on git's own safety check", () =>
    expect(decide("git rm new.txt")).toBe("approve"));
  test("git rm --force needs the same evidence as rm", () => {
    expect(decide("git rm -f a.txt")).toBe("approve");
    expect(decide("git rm -rf dir")).toBe("approve");
    expect(decide("git rm -rf mixed")).toBe("human");
    expect(decide("git rm -f new.txt")).toBe("human");
    expect(decide("git rm -f 'dir/*'")).toBe("human");
    expect(decide("git rm -f ':(glob)dir/*'")).toBe("human");
    expect(decide("git rm -f --pathspec-from-file=list a.txt")).toBe("human");
    expect(decide("git rm -f a.txt", repo)).toBe("human");
    scenario(
      () => write(join(wt, "a.txt"), "changed"),
      () => expect(decide("git rm -f a.txt")).toBe("human"),
    );
    scenario(
      () => rmSync(join(wt, "a.txt")),
      () => expect(decide("git rm -f a.txt")).toBe("approve"),
    );
  });
});

describe("git reset --hard, checkout and restore", () => {
  test("clean worktree: reset, checkout and restore lose nothing", () => {
    expect(decide("git reset --hard")).toBe("approve");
    expect(decide("git reset --hard HEAD")).toBe("approve");
    expect(decide("git reset -q --hard HEAD~1")).toBe("approve"); // dropped commit is on origin/main
    expect(decide("git reset --hard origin/main")).toBe("approve");
    expect(decide("git checkout -- .")).toBe("approve");
    expect(decide("git checkout .")).toBe("approve");
    expect(decide("git restore a.txt dir")).toBe("approve");
    expect(decide("git restore -SW -- a.txt")).toBe("approve");
  });

  test.each([
    "git reset --hard --recurse-submodules",
    "git reset --hard HEAD -- a.txt",
    "git reset --hard HEAD 'HEAD~1'",
    "git reset --hard nosuchref",
    "git clean -fdx",
    "git checkout HEAD~1 -- a.txt",
    "git checkout -f",
    "git checkout -- .github",
    "git restore --source=HEAD~1 a.txt",
    "git restore -s HEAD~1 a.txt",
    "git restore -p a.txt",
    "git restore missing.txt",
    "git restore '*.txt'",
    "A=1 git reset --hard",
    "git -C . reset --hard",
    "git status && git reset --hard",
    "bash -c 'git reset --hard'",
  ])("sends %s to a human", (command) => expect(decide(command)).toBe("human"));

  test("uncommitted changes keep reset, checkout and restore with a human", () => {
    scenario(
      () => write(join(wt, "a.txt"), "changed"),
      () => {
        expect(decide("git reset --hard")).toBe("human");
        expect(decide("git checkout -- .")).toBe("human");
        expect(decide("git checkout -- a.txt")).toBe("human");
        expect(decide("git restore a.txt")).toBe("human");
        expect(decide("git checkout -- dir")).toBe("approve"); // the change is elsewhere
      },
    );
    scenario(
      () => {
        write(join(wt, "a.txt"), "staged");
        git(wt, ["add", "a.txt"]);
      },
      () => {
        expect(decide("git reset --hard")).toBe("human");
        expect(decide("git restore -SW a.txt")).toBe("human");
        expect(decide("git checkout -- a.txt")).toBe("approve"); // index already matches
      },
    );
    scenario(
      () => rmSync(join(wt, "a.txt")),
      () => {
        expect(decide("git checkout -- a.txt")).toBe("approve");
        expect(decide("git restore a.txt")).toBe("approve");
        expect(decide("git reset --hard")).toBe("human");
      },
    );
  });

  test("a commit only on this branch keeps reset to an older commit with a human", () => {
    write(join(wt, "local.txt"), "local");
    git(wt, ["add", "local.txt"]);
    git(wt, ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "local"]);
    try {
      expect(decide("git reset --hard HEAD~1")).toBe("human");
      expect(decide("git reset --hard")).toBe("approve");
    } finally {
      git(wt, ["reset", "-q", "--hard", "HEAD~1"]);
    }
  });

  test("an untracked file where the target writes keeps reset with a human", () => {
    git(wt, ["reset", "-q", "--hard", "HEAD~1"]);
    try {
      write(join(wt, "two.txt"), "untracked in the way");
      expect(decide("git reset --hard origin/main")).toBe("human");
      rmSync(join(wt, "two.txt"));
      expect(decide("git reset --hard origin/main")).toBe("approve");
    } finally {
      git(wt, ["reset", "-q", "--hard", "origin/main"]);
    }
  });

  test("the main clone stays human", () => {
    expect(decide("git reset --hard", repo)).toBe("human");
    expect(decide("git checkout -- .", repo)).toBe("human");
  });

  test("evidence is read at decision time", () => {
    expect(decide("rm a.txt")).toBe("approve");
    scenario(
      () => write(join(wt, "a.txt"), "changed"),
      () => expect(decide("rm a.txt")).toBe("human"),
    );
    expect(decide("rm a.txt")).toBe("approve");
  });
});
