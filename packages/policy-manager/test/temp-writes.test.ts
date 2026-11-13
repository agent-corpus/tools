import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { tempRoots } from "../src/evidence.js";
import { evaluate, hash } from "../src/policy.js";
import { parseProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
const strict = parseProfile(JSON.stringify({ version: 1, mode: "strict" }));
const posix = (path: string) => path.split("\\").join("/");
const windows = process.platform === "win32";

let root: string, main: string, worktree: string, outside: string;
function git(cwd: string, args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}
function bash(command: string, cwd = worktree, profile = permissive) {
  const r: Request = { sessionId: "t", harness: "claude", cwd, tool: "Bash", input: { command } };
  return evaluate(r, undefined, profile);
}
function write(file_path: string, tool = "Write", profile = permissive) {
  const r: Request = {
    sessionId: "t",
    harness: "claude",
    cwd: worktree,
    tool,
    input: { file_path, content: "x" },
  };
  return evaluate(r, undefined, profile);
}
function link(target: string, path: string, dir = false) {
  symlinkSync(target, path, dir ? "junction" : "file");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "temp-writes-test-"));
  main = join(root, "main");
  worktree = join(root, "wt");
  outside = join(root, "outside");
  mkdirSync(outside);
  execFileSync("git", ["init", "-b", "main", main], { stdio: "ignore" });
  git(main, ["config", "user.name", "T"]);
  git(main, ["config", "user.email", "t@example.com"]);
  writeFileSync(join(main, "a.txt"), "a");
  git(main, ["add", "a.txt"]);
  git(main, ["commit", "-m", "init"]);
  git(main, ["worktree", "add", "-b", "feature", worktree]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("writes to the system temp directory", () => {
  test("the temp root is known", () => {
    expect(tempRoots().length).toBeGreaterThan(0);
  });

  test("file tools and shell writes outside any repository are approved", () => {
    for (const d of [
      write(join(outside, "notes.md")),
      write(join(outside, "new", "deep", "notes.md"), "Edit"),
    ])
      expect(d).toMatchObject({ decision: "approve", category: "temp-write" });
    for (const d of [
      bash(`echo hi > ${posix(outside)}/out.txt`),
      bash(`echo hi >> ${posix(outside)}/out.txt`),
      bash(`echo hi | tee ${posix(outside)}/tee.txt`),
      bash(`mkdir -p ${posix(outside)}/a/b`),
      bash(`cp a.txt ${posix(outside)}/copy.txt`),
      bash("echo hi > out.txt", outside),
    ])
      expect(d.decision).toBe("approve");
  });

  test.skipIf(windows)("/tmp and /private/tmp are temp roots", () => {
    expect(bash("echo hi > /tmp/policy-temp-writes-test.txt").decision).toBe("approve");
    expect(write("/tmp/policy-temp-writes-test/x.md").category).toBe("temp-write");
    if (process.platform === "darwin")
      expect(write("/private/tmp/policy-temp-writes-test/x.md").decision).toBe("approve");
  });

  test("repository rules still win inside a temp directory", () => {
    const d = write(join(main, "b.txt"));
    expect(d.decision).toBe("human");
    expect(d.reason).toMatch(/linked worktree/);
    expect(bash(`echo hi > ${posix(main)}/b.txt`).decision).toBe("human");
    expect(write(join(worktree, "b.txt")).category).toBe("worktree-write");
  });

  test("protected and credential names stay protected", () => {
    for (const path of [
      join(outside, ".env"),
      join(outside, "x", ".ssh", "authorized_keys"),
      join(outside, ".claude", "settings.json"),
      join(outside, "AGENTS.md"),
      join(outside, "id_rsa"),
      join(outside, "server.pem"),
    ]) {
      const d = write(path);
      expect(d.decision, path).toBe("human");
      expect(d.category, path).toBe("sensitive");
    }
  });

  test("`..` traversal out of the temp directory is resolved first", () => {
    const traversal = `${posix(outside)}/../../../../../../../../etc/policy-test`;
    expect(bash(`echo x > ${traversal}`).decision).not.toBe("approve");
    expect(write(traversal).decision).not.toBe("approve");
    if (!windows) {
      expect(bash("echo x > /tmp/../etc/policy-test").decision).not.toBe("approve");
      expect(bash("cd /tmp/.. && echo x > etc/policy-test").decision).not.toBe("approve");
    }
  });

  test("a symlink from the temp directory into a repository's .git is refused", () => {
    const dir = join(outside, "to-git");
    link(join(main, ".git"), dir, true);
    expect(write(join(dir, "config")).category).toBe("sensitive");
    expect(write(join(dir, "hooks", "pre-commit")).decision).toBe("human");
    expect(bash(`echo x > ${posix(dir)}/config`).decision).toBe("human");
  });

  test("a symlink from the temp directory into a main checkout follows the repository rules", () => {
    const dir = join(outside, "to-main");
    link(main, dir, true);
    expect(write(join(dir, "a.txt")).decision).toBe("human");
    const file = join(outside, "a-link.txt");
    link(join(main, "a.txt"), file);
    expect(write(file).decision).toBe("human");
    expect(bash(`echo x > ${posix(file)}`).decision).toBe("human");
  });

  test.skipIf(windows)("a dangling symlink is judged by its target", () => {
    const ssh = join(outside, "ssh-link");
    link(join(homedir(), ".ssh", "policy-test-missing"), ssh);
    expect(write(ssh).category).toBe("sensitive");
    expect(bash(`echo x > ${posix(ssh)}`).decision).toBe("human");
    const away = join(outside, "away-link");
    link("/policy-test-missing-dir/file", away);
    expect(write(away).decision).toBe("human");
    const dirLink = join(outside, "dangling-dir");
    link("/policy-test-missing-dir", dirLink, true);
    expect(write(join(dirLink, "f")).decision).toBe("human");
  });

  test("the policy service's own session directories stay protected", () => {
    const state = join(tmpdir(), `acp-${process.getuid?.() ?? "user"}-${"0".repeat(24)}`);
    for (const name of ["audit.jsonl", "token", "service.sock"]) {
      expect(write(join(state, name)).decision).toBe("human");
      expect(bash(`echo x > ${posix(join(state, name))}`).decision).toBe("human");
    }
    expect(write(join(outside, "ACP-1-x", "audit.jsonl")).decision).toBe("human");
    mkdirSync(join(outside, "acp-1-real"));
    const alias = join(outside, "innocent");
    link(join(outside, "acp-1-real"), alias, true);
    expect(write(join(alias, "audit.jsonl")).decision).toBe("human");
    expect(bash(`mkdir -p ${posix(state)}`).decision).toBe("human");
  });

  test.skipIf(windows)("a hard link that may alias another file is not a temp write", () => {
    const original = join(outside, "original.txt");
    writeFileSync(original, "x");
    linkSync(original, join(outside, "hard.txt"));
    expect(write(join(outside, "hard.txt")).decision).toBe("human");
  });

  test("option values that name a target are judged", () => {
    expect(bash("cp --target-directory=/etc a.txt").decision).toBe("human");
    expect(bash("cp -t/etc a.txt").decision).toBe("human");
    expect(bash(`cp --target-directory=${posix(outside)} a.txt`).decision).toBe("approve");
  });

  test("the temp root itself and the filesystem root are not writable targets", () => {
    for (const temp of tempRoots()) expect(write(temp).decision).toBe("human");
  });

  test("strict mode is unchanged", () => {
    expect(write(join(outside, "notes.md"), "Write", strict).decision).toBe("human");
    expect(bash(`echo hi > ${posix(outside)}/out.txt`, worktree, strict).decision).toBe("human");
  });
});

describe("deletion in scratch and temp directories", () => {
  const approved = (command: string, cwd = worktree) => {
    const d = bash(command, cwd);
    expect(d.decision, command).toBe("approve");
    expect(d.reason, command).toBe("Delete within a scratch directory");
  };
  const refused = (command: string, cwd = worktree) =>
    expect(bash(command, cwd).decision, command).not.toBe("approve");

  test("disposable targets are approved", () => {
    const scratch = join(outside, "scratchpad");
    mkdirSync(join(scratch, "sub"), { recursive: true });
    writeFileSync(join(scratch, "a.txt"), "x");
    approved(`rm -rf ${posix(scratch)}/sub`);
    approved(`rm ${posix(scratch)}/a.txt`);
    approved(`rm -rf ${posix(scratch)}/*`);
    approved(`rmdir ${posix(scratch)}/sub`);
    approved(`unlink ${posix(scratch)}/a.txt`);
    approved(`rm -f -- ${posix(scratch)}/missing.txt`);
    approved(`find ${posix(scratch)} -name '*.tmp' -delete`);
    approved("rm -rf sub a.txt", scratch);
    approved(`rm -rf ${posix(scratch)}`);
  });

  test.skipIf(windows)("the Claude scratchpad shape is approved", () => {
    const base = process.platform === "darwin" ? "/private/tmp" : "/tmp";
    const pad = mkdtempSync(`${base}/policy-test-claude-`);
    try {
      mkdirSync(join(pad, "proj", "session", "scratchpad"), { recursive: true });
      approved(`rm -rf ${pad}/proj/session/scratchpad/*`);
    } finally {
      rmSync(pad, { recursive: true, force: true });
    }
  });

  test.skipIf(windows)("temp roots themselves and escapes are refused", () => {
    for (const command of [
      "rm -rf /tmp",
      "rm -rf /tmp/",
      "rm -rf /private/tmp",
      "rm -rf /tmp/..",
      "rm -rf /tmp/x/../../Users",
      "rm -rf /tmp/*",
      "rm -rf /tmp/.*",
      "rm -rf /tmp/*/x",
      "rm -rf $TMPDIR",
      "rm -rf $UNSET_POLICY_TEST_VAR/x",
      "rm -rf $(mktemp -d)",
      "rm -rf",
      "find /tmp -delete",
      `find -L ${posix(outside)} -delete`,
      `find ${posix(outside)} -exec rm {} ;`,
    ])
      refused(command);
  });

  test("a leading ~ is the home directory, not a directory named ~", () => {
    for (const command of [
      "rm -rf ~",
      "rm -rf ~/policy-test-x",
      "rmdir ~/policy-test-x",
      "find ~/policy-test-x -delete",
      "rm -rf ~root/x",
      "rm -rf ~+/x",
      "echo x > ~/policy-test-x",
      "mkdir -p ~/policy-test-x",
      "touch ~/policy-test-x",
      "echo x | tee ~/policy-test-x",
      "cp a.txt ~/policy-test-x",
    ]) {
      refused(command, outside);
      if (!command.includes("~root") && !command.includes("~+")) refused(command, "/");
    }
    expect(write("~/policy-test-x").decision).toBe("human");
  });

  test("functions, loops and cd do not launder a target", () => {
    for (const command of [
      "f() { rm -rf ~/policy-test-x; }; f",
      "for d in ~/policy-test-x; do rm -rf $d; done",
      `cd ${posix(outside)} && rm -rf ~`,
      `cd ${posix(outside)} && find sub -delete ${posix(main)}`,
      "f() { echo x > ~/policy-test-x; }; f",
      `cd ${posix(main)} && rm -rf a.txt`,
    ])
      refused(command, outside);
    mkdirSync(join(outside, "loop", "a"), { recursive: true });
    approved(`f() { rm -rf ${posix(outside)}/loop/a; }; f`);
  });

  test("zsh =name (an executable's path) is never a temp target", () => {
    for (const command of [
      "rm -rf =node",
      "echo x > =node",
      "echo x | tee =node",
      "cp a.txt =node",
      "touch =node",
    ])
      refused(command, outside);
  });

  test("find leading options do not hide the start path", () => {
    const away = posix(main);
    for (const command of [
      `find -P ${away} -delete`,
      `find -E ${away} -delete`,
      `find -x ${away} -delete`,
      `find -O3 ${away} -delete`,
      `find -D tree ${away} -delete`,
      `find -- ${away} -delete`,
      `find -H ${posix(outside)} -delete`,
      `find -f ${posix(outside)} -delete`,
      `find -Z ${posix(outside)} -delete`,
      `find -xP ${away} -delete`,
      `find -EP ${away} -delete`,
      `find -Ex ${away} -delete`,
      `find -sx ${away} -delete`,
      `find -xL ${away} -delete`,
      `find -xQ -delete`,
      `find -bogus -delete`,
      // bfs takes start paths, -f and -- inside the expression.
      `find sub -delete ${away}`,
      `find -name x ${away} -delete`,
      `find sub -f ${away} -delete`,
      `find sub -- ${away} -delete`,
      `find sub -name x -delete -print ${away}`,
      `find ${posix(outside)} -files0-from x -delete`,
    ])
      refused(command, outside);
    mkdirSync(join(outside, "find-opts"), { recursive: true });
    approved(`find -P ${posix(outside)}/find-opts -delete`);
    approved(`find -- ${posix(outside)}/find-opts -name '*.tmp' -delete`);
    approved(`find -xP ${posix(outside)}/find-opts -delete`);
    approved("find -name '*.tmp' -delete", join(outside, "find-opts"));
    approved("find . ! -name keep -delete", join(outside, "find-opts"));
    approved("find . -not -name keep -delete", join(outside, "find-opts"));
    approved("find . \\( -name a -o -name b \\) -delete", join(outside, "find-opts"));
    approved("find ! -name keep -delete", join(outside, "find-opts"));
  });

  test("rmdir -p is refused: it removes ancestors up to and past the root", () => {
    mkdirSync(join(outside, "p", "q"), { recursive: true });
    refused(`rmdir -p ${posix(outside)}/p/q`);
    refused(`rmdir --parents ${posix(outside)}/p/q`);
    refused(`rmdir -vp ${posix(outside)}/p/q`);
    refused(`rmdir --parent ${posix(outside)}/p/q`);
    refused(`rmdir --p ${posix(outside)}/p/q`);
    approved(`rmdir ${posix(outside)}/p/q`);
  });

  test("the temp root itself is refused on every platform", () => {
    for (const temp of tempRoots()) refused(`rm -rf ${posix(temp)}`);
    refused(`rm -rf ${posix(outside)}/../../..`);
  });

  test("symlinks out of the temp directory are refused", () => {
    const toMain = join(outside, "del-to-main");
    link(main, toMain, true);
    refused(`rm -rf ${posix(toMain)}`);
    refused(`rm -rf ${posix(toMain)}/`);
    const toHome = join(outside, "del-to-home");
    link(homedir(), toHome, true);
    refused(`rm -rf ${posix(toHome)}`);
    refused(`rm -rf ${posix(toHome)}/*`);
  });

  test("repositories and their worktrees are not disposable", () => {
    refused(`rm -rf ${posix(main)}`);
    refused(`rm -rf ${posix(join(main, "a.txt"))}`);
    refused(`rm -rf ${posix(worktree)}`);
    refused(`rm -rf ${posix(root)}`);
    refused(`find ${posix(root)} -delete`);
  });

  test("policy state, protected and credential names are refused", () => {
    const state = join(tmpdir(), `acp-${process.getuid?.() ?? "user"}-${"0".repeat(24)}`);
    refused(`rm -rf ${posix(state)}`);
    refused(`rm -f ${posix(join(state, "audit.jsonl"))}`);
    mkdirSync(join(outside, "acp-2-del"), { recursive: true });
    refused(`rm -rf ${posix(outside)}/acp-2-del`);
    const alias = join(outside, "del-alias");
    link(join(outside, "acp-2-del"), alias, true);
    refused(`rm -rf ${posix(alias)}`);
    refused(`rm -rf ${posix(outside)}/x/.ssh`);
    refused(`rm -f ${posix(outside)}/.env`);
  });

  test("strict mode still asks", () => {
    expect(bash(`rm -f ${posix(outside)}/a.txt`, worktree, strict).decision).toBe("human");
  });
});

describe("temp-write classification", () => {
  test("the classifier may answer temp-write and it approves", () => {
    const dir = join(root, "session");
    mkdirSync(dir, { mode: 0o700 });
    const s = new PolicySession(dir, "claude", "t", permissive);
    const r: Request = {
      sessionId: "t",
      harness: "claude",
      cwd: worktree,
      tool: "Bash",
      input: { command: "echo $UNKNOWN_VAR" },
    };
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("deny");
    const d = s.classify({
      requestHash: hash(r),
      category: "temp-write",
      confidence: 0.97,
      recoverable: true,
      rationale: "Only prints.",
    });
    expect(d.decision).toBe("approve");
    expect(d.category).toBe("temp-write");
  });
});
