import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
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

  test("`..` after a symlink leaves the link's target, as the kernel does", () => {
    // `away/inner` is a link to a directory inside the main checkout: `away/inner/..` is `main`.
    mkdirSync(join(main, "inner"), { recursive: true });
    const away = join(outside, "dotdot");
    mkdirSync(away, { recursive: true });
    link(join(main, "inner"), join(away, "inner"), true);
    for (const command of [
      "rm -rf inner/../a.txt",
      "rmdir inner/../x",
      "find inner/../x -delete",
      "echo x > inner/../a.txt",
      "touch inner/../x",
      "mkdir -p inner/../x",
      "echo x | tee inner/../x",
      `cp ${posix(join(outside, "notes.md"))} inner/../x`,
      "cd inner && rm -rf ../a.txt",
      "cd inner && echo x > ../a.txt",
      `rm -rf ${posix(away)}/inner/../a.txt`,
    ])
      refused(command, away);
    expect(write(`${join(away, "inner")}${sep}..${sep}a.txt`).decision).toBe("human");
    // Without a symlink, `..` stays inside the temp directory.
    mkdirSync(join(away, "plain"), { recursive: true });
    approved("rm -rf plain/../plain", away);
  });

  test("cd is logical: cd link && cd .. returns beside the link", () => {
    // `main/out` links into the temp directory; the shell's `cd ..` from it lands in `main`.
    mkdirSync(join(outside, "build", "out"), { recursive: true });
    link(join(outside, "build", "out"), join(main, "out"), true);
    for (const command of [
      "cd out && cd .. && rm -rf dist",
      "cd out/.. && rm -rf dist",
      "cd out && cd .. && echo x > w.txt",
      "cd out/.. && echo x > w.txt",
      "cd out && chdir .. && rm -rf dist",
      "chdir out/.. && rm -rf dist",
    ])
      refused(command, main);
  });

  test("every way of changing directory moves the cwd or goes to a person", () => {
    const away = posix(main);
    for (const command of [
      `chdir ${away} && rm -rf dist`,
      `chdir ${away}; rm -rf dist`,
      `chdir ${away} && echo x > w.txt`,
      `pushd ${away} && rm -rf dist`,
      `popd && rm -rf dist`,
      `builtin cd ${away} && rm -rf dist`,
      `command cd ${away} && rm -rf dist`,
      `time cd ${away} && rm -rf dist`,
      `nocorrect cd ${away} && rm -rf dist`,
      `\\cd ${away} && rm -rf dist`,
      `${away} && rm -rf dist`,
      ".. && rm -rf dist",
      "cd - && rm -rf dist",
      `OLDPWD=${away} cd - && rm -rf dist`,
      `CDPATH=${posix(root)} cd main && rm -rf dist`,
      "setopt chase_links && cd out/.. && rm -rf dist",
      "setopt auto_cd && rm -rf dist",
      "set -o physical && rm -rf dist",
      "f() { chdir /etc; }; f; rm -rf dist",
    ])
      refused(command, outside);
    // A tracked chdir into scratch still approves a scratch delete.
    mkdirSync(join(outside, "chd", "dist"), { recursive: true });
    approved(`chdir ${posix(join(outside, "chd"))} && rm -rf dist`, outside);
  });

  test("directory-stack entries and rc-file redirects go to a person", () => {
    const temp = posix(outside);
    for (const command of [
      `cd ${temp} && cd +1 && rm -rf dist`,
      `cd ${temp} && chdir +1 && rm -rf dist`,
      `cd ${temp} && cd +1 && echo x > w.txt`,
      `cd ${temp} && cd -1 && rm -rf dist`,
      `cd ${temp} && pushd +1 && rm -rf dist`,
      // CDABLE_VARS: `cd foo` goes to $foo when no directory foo exists.
      `foo=${posix(main)}; cd foo && rm -rf dist`,
      "cd no-such-dir && rm -rf dist",
    ])
      refused(command, main);
    mkdirSync(join(outside, "bare", "dist"), { recursive: true });
    approved("cd bare && rm -rf dist", outside);
    approved("cd ./bare && rm -rf dist", outside);
  });

  test("a cd into a missing bare name leaves the cwd unknown, unless the script creates it", () => {
    // A missing name the script does not create: nothing relative is approved after it.
    for (const command of [
      "cd nosuch && touch a",
      "cd nosuch && echo x > w.txt",
      "cd nosuch && cd sub && rm -rf dist",
      "cd nosuch && cd .. && rm -rf dist",
    ])
      refused(command, outside);
    // Commands that do not depend on the cwd still run.
    for (const command of ["cd nosuch && ls", `cd nosuch && touch ${posix(outside)}/abs.txt`]) {
      const d = bash(command, outside);
      expect(d.decision, command).toBe("approve");
    }
    // A directory the script creates first is a known destination.
    for (const command of [
      "mkdir -p made && cd made && touch a",
      "mkdir -p made2/deep && cd made2 && touch a",
      "mkdir -p made3/deep && cd made3/deep && rm -rf dist",
      "mkdir made4 && cd made4 && echo x > w.txt",
    ])
      expect(bash(command, outside).decision, command).toBe("approve");
  });

  test("a path below a directory an earlier command fills is not trusted", () => {
    // A clone, copy, move or archive can bring a symlink that leaves temp.
    for (const command of [
      "git clone https://example.com/o/r.git cl && rm -rf cl/out/dist",
      "git clone https://example.com/o/r.git cl && cd cl && rm -rf out/dist",
      "git clone https://example.com/o/r.git cl && echo x > cl/out/w.txt",
      "git clone https://example.com/o/r.git cl && touch cl/out/w.txt",
      "cp -R sub made && rm -rf made/inner/dist",
      "mv sub made && rm -rf made/inner/dist",
      "cp -R sub made && cd made && rm -rf inner/dist",
      "tar xf a.tar && rm -rf ex/out/dist",
      "unzip a.zip && rm -rf ex/out/dist",
      "for x in 1 2; do rm -rf cl/out/dist; git clone https://example.com/o/r.git cl; done",
      "rm -rf cl/out/dist | git clone https://example.com/o/r.git cl",
      // After anything that can create a symlink, no temp path in the script is trusted.
      "git clone https://example.com/o/r.git cl2 && rm -rf cl2",
      `git clone https://example.com/o/r.git cl3 && echo x > ${posix(outside)}/w.txt`,
    ])
      refused(command, outside);
    expect(bash("mkdir -p fresh/out && rm -rf fresh/out/dist", outside).decision).toBe("approve");
  });

  // Each command runs Git for repository evidence, which is slow on Windows runners.
  test("an existing path below where an earlier command copies or extracts is not trusted", {
    timeout: 30_000,
  }, () => {
    const dir = join(outside, "refill");
    mkdirSync(join(dir, "made", "inner"), { recursive: true });
    mkdirSync(join(dir, "ex", "out"), { recursive: true });
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "w.txt"), "x");
    writeFileSync(join(dir, "f"), "x");
    // The earlier command can replace a directory, or create the last component, as a symlink.
    for (const command of [
      "rm -rf made && cp -R sub made && rm -rf made/inner/dist",
      "mv made old && cp -R sub made && rm -rf made/inner/dist",
      "rm -rf made && mv sub made && rm -rf made/inner/dist",
      "rm -rf made && cp -R sub made && echo x > made/inner/w.txt",
      "tar xf a.tar && rm -rf ex/out/dist",
      "tar -xzf a.tgz -C ex && rm -rf ex/out/dist",
      "tar xf b.tar && echo x > w.txt",
      "tar xf b.tar && echo x >> w.txt",
      "tar xf b.tar && touch w.txt",
      "tar xf b.tar && echo x | tee w.txt",
      "tar xf b.tar && cp f lnk",
      "tar xf b.tar && rm -rf lnk/",
      "cp -R sub/. . && echo x > w.txt",
      "cp -R sub/ new0 && echo x > new0/w.txt",
      "mv sub made && echo x > made",
      "ln -s sub made7 && echo x > made7/w.txt",
      "unzip b.zip && echo x > w.txt",
      "unzip -d ex b.zip && rm -rf ex/out/dist",
      "echo x > ex/out/w.txt & tar xf a.tar",
      // Path-qualified programs, wrappers, nested shells, link-copying options and globs.
      "/bin/cp -R sub mad1 && rm -rf mad1/inner/dist",
      "/usr/bin/tar xf a.tar && rm -rf ex/out/dist",
      "/bin/ln -s sub mad2 && echo x > mad2/w.txt",
      "/bin/mv sub mad3 && rm -rf mad3/inner/dist",
      "echo mad4 | xargs cp -R sub && rm -rf mad4/inner/dist",
      "bash -c 'cp -R sub mad5' && rm -rf mad5/inner/dist",
      "sh -c 'cp -R sub mad6 && rm -rf mad6/inner/dist'",
      "cp -R sub mad7 && bash -c 'rm -rf mad7/inner/dist'",
      "rsync -t -a sub/ mad8 && rm -rf mad8/inner/dist",
      "cp -R sub/. mad?13 && rm -rf mad13/inner/dist",
      "cp -P lnk mad9 && echo x > mad9",
      "cp -d lnk mad10 && echo x > mad10",
      "cp --no-dereference lnk mad11 && echo x > mad11",
      "tar xf b.tar && rm -rf lnk/*",
      "pax -r < a.pax && rm -rf ex/out/dist",
      "python3 -c 'print(1)' && rm -rf ex/out/dist",
      "rm -rf ex/out/dist | cp -R sub ex",
      "gh repo clone o/r mad12 && rm -rf mad12/inner/dist",
      "gh pr checkout 1 && echo x > w.txt",
      "git -C . pull && echo x > w.txt",
      "git worktree add ../mad14 && echo x > w.txt",
      "wget -r ftp://example.com/x && echo x > w.txt",
      "for f in a b; do echo $f > o$f; cp -R sub ex; done",
      "echo x > w.txt & node x.js",
    ])
      refused(command, dir);
    // Commands that create no symlink keep later temp paths trusted.
    for (const command of [
      "rm -rf made && cp -R sub made",
      "mkdir -p new1 && cp f new1/a && cp f new1/b",
      "mkdir -p new1 && sort f > new1/a && sort f > new1/b",
      "git status; mkdir -p new1 && echo a > new1/a",
      "mkdir new1 && cd new1 && git init && echo x > README.md",
      "cp -p f new2 && /bin/cp f new3 && rm -rf new2 new3",
      "grep -l x f | sort > new4 && rm new4",
      "bash -c 'echo x > new5' && rm new5",
      // Read-only gh and git, and a loop or pipeline that has ended before the next command.
      "gh pr view 1 --json body > body.md && rm body.md",
      "git -C . status && git push origin x && seq 3 > n.txt",
      "echo x | tee a.txt; node x.js",
      "for f in a b; do echo $f > o$f; done; node x.js",
    ])
      expect(bash(command, dir).decision, command).toBe("approve");
  });

  test("a variable named like a created directory makes the cd unknown (CDABLE_VARS)", () => {
    for (const command of [
      `made5=${posix(main)}; false && mkdir made5; cd made5 && rm -rf dist`,
      `mkdir made6 && rmdir made6 && made6=${posix(main)} && cd made6 && rm -rf dist`,
    ])
      refused(command, outside);
  });

  test("the reviewer's create-then-cd idioms are approved in a worktree", () => {
    for (const command of [
      "mkdir -p newdir && cd newdir && ls",
      "git clone https://example.com/o/cl.git && cd cl && ls",
      "git clone https://example.com/o/r.git cl && cd cl && ls",
      "git worktree add ../wt2 && cd ../wt2 && ls",
      "cd newdir && ls",
    ])
      expect(bash(command).decision, command).toBe("approve");
  });

  test("builtins and keywords are commands, not AUTO_CD", () => {
    const dir = join(outside, "builtins");
    for (const name of ["export", "set", "test"])
      mkdirSync(join(dir, name, "dist"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    approved("export FOO=1 && rm -rf dist", dir);
    approved("set -e; rm -rf dist", dir);
    mkdirSync(join(dir, "nocmd-xyz"), { recursive: true });
    refused("nocmd-xyz && rm -rf dist", dir);
    // bash-only builtins are not commands in zsh, so AUTO_CD enters a directory of that name.
    for (const name of ["help", "bind", "caller", "compgen", "complete", "mapfile", "readarray"]) {
      mkdirSync(join(dir, name, "dist"), { recursive: true });
      refused(`${name} && rm -rf dist`, dir);
    }
  });

  test("CDPATH inherited from the environment makes a relative cd unknown", () => {
    const saved = process.env.CDPATH;
    process.env.CDPATH = posix(root);
    try {
      refused("cd main && rm -rf dist", outside);
      mkdirSync(join(outside, "cdp", "dist"), { recursive: true });
      approved("cd ./cdp && rm -rf dist", outside);
    } finally {
      if (saved === undefined) delete process.env.CDPATH;
      else process.env.CDPATH = saved;
    }
  });

  test.skipIf(windows)("a backslash is a file-name character on POSIX", () => {
    const name = `${posix(main)}/x${"\\..".repeat(16)}\\tmp\\policy-test-y`;
    for (const command of [
      `echo x > '${name}'`,
      `mkdir -p '${name}'`,
      `rm -rf '${name}'`,
      `cp a.txt '${name}'`,
    ])
      refused(command, outside);
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
