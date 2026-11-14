import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { evaluate } from "../src/policy.js";
import { parseProfile } from "../src/profile.js";
import type { Request } from "../src/types.js";

const profile = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
const posix = (path: string) => path.split("\\").join("/");
const windows = process.platform === "win32";
// Every decision reads live Git evidence, which is slow on Windows runners.
const SLOW = { timeout: 30_000 };

let root: string, main: string, worktree: string, inner: string, outside: string, keys: string;
function git(cwd: string, args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}
function bash(command: string, cwd = worktree) {
  const r: Request = { sessionId: "t", harness: "claude", cwd, tool: "Bash", input: { command } };
  return evaluate(r, undefined, profile);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "operands-test-"));
  main = join(root, "main");
  worktree = join(root, "wt");
  inner = join(main, ".worktrees", "inner");
  outside = join(root, "outside");
  keys = join(root, "keys");
  mkdirSync(outside);
  mkdirSync(keys);
  execFileSync("git", ["init", "-b", "main", main], { stdio: "ignore" });
  git(main, ["config", "user.name", "T"]);
  git(main, ["config", "user.email", "t@example.com"]);
  writeFileSync(join(main, "a.txt"), "a");
  git(main, ["add", "a.txt"]);
  git(main, ["commit", "-m", "init"]);
  git(main, ["worktree", "add", "-b", "feature", worktree]);
  git(main, ["worktree", "add", "-b", "inner", inner]);
  for (const name of [
    "id_rsa",
    "credentials",
    ".env",
    "server.pem",
    "tls.key",
    "secrets.json",
    "notes.txt",
  ])
    writeFileSync(join(keys, name), "x");
  mkdirSync(join(keys, "src"));
  writeFileSync(join(keys, "src", "secrets.ts"), "export {};");
  writeFileSync(join(keys, "src", "app.ts"), "export {};");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("grep and rg glob options", () => {
  test.each([
    'grep -rn "x" --include=*.md --include=*.json .',
    "grep -rn x --exclude=*.lock --exclude-dir=node_* .",
    "egrep -r x --include=*.ts src",
    "rg x -g*.ts",
    "rg x --glob=*.ts",
    "rg x --iglob=*.TS src",
    "grep -r x --include *.md .",
  ])("approves %s", (command) => {
    expect(bash(command).decision).toBe("approve");
  });

  test.each([
    // A glob in the option name could expand to another option.
    "grep --inc[l]ude=*.md x .",
    "grep --forc[e] x .",
    "r[g] x",
    "rg -[g]x x",
    // Not a glob-valued option.
    "rg --pre=* x",
    "grep -e* x .",
    // The option is only known for grep and rg.
    "sed --include=*.md x",
    "rm --include=*.md",
  ])("refuses %s", (command) => {
    expect(bash(command).decision).toBe("human");
  });

  test("a glob option that selects credential files is a credential read", () => {
    const d = bash("grep -r BEGIN --include=*.pem .");
    expect(d.decision).toBe("human");
    expect(d.category).toBe("sensitive");
  });
});

describe("az boards query and other Azure DevOps reads", () => {
  test.each([
    'az boards query --organization https://dev.azure.com/o --project p --wiql "SELECT [System.Id] FROM WorkItems" -o table',
    "az boards query --id 0b1c2d3e -o json",
    "az boards work-item show --id 1 --org https://dev.azure.com/o",
    "az repos pr list --repository r -o table",
    "az pipelines runs list --top 5",
    "az pipelines runs show --id 7",
  ])("approves %s", (command) => {
    const d = bash(command);
    expect(d.decision).toBe("approve");
    expect(d.category).toBe("cloud-read");
  });

  test.each([
    'az boards query --wiql "SELECT [System.Id] FROM WorkItems" --debug',
    'az boards query --wiql "SELECT [System.Id] FROM WorkItems" --endpoint-url https://x',
    "az boards work-item create --title t --type Bug",
    "az boards work-item update --id 1 --state Closed",
    "az devops invoke --area wit --resource comments",
    "az repos pr create --title t",
  ])("does not approve %s", (command) => {
    expect(bash(command).decision).toBe("human");
  });

  test("a query naming a secret is a credential request", () => {
    const d = bash('az boards query --wiql "SELECT [Custom.Secret] FROM WorkItems"');
    expect(d.category).toBe("sensitive");
  });
});

describe("cp, ln and chmod from a main checkout into the temp directory", SLOW, () => {
  test("sources are reads, so copying or linking out of the main checkout is a temp write", () => {
    for (const command of [
      `cp a.txt ${posix(outside)}/copy.txt`,
      `cp -R ${posix(main)} ${posix(outside)}/clone`,
      `ln -s ${posix(main)}/a.txt ${posix(outside)}/link.txt`,
      `ln -sfn ${posix(main)} ${posix(outside)}/main-link`,
      `cp -t ${posix(outside)} a.txt`,
      `cp --target-directory=${posix(outside)} a.txt`,
      `chmod +x ${posix(outside)}/run.sh`,
      `chmod u+x,go-w ${posix(outside)}/run.sh`,
      `chmod -w ${posix(outside)}/run.sh`,
    ])
      expect(bash(command, main).decision, command).toBe("approve");
    expect(bash(`ln -s ${posix(main)}/a.txt`, outside).decision).toBe("approve");
  });

  test.each([
    (o: string, m: string) => `cp ${o}/x ${m}/b.txt`,
    (o: string, m: string) => `ln -s ${o}/x ${m}/link`,
    (o: string, m: string) => `cp -t ${m} ${o}/x`,
    (o: string, m: string) => `cp -t${m} ${o}/x`,
    (o: string, m: string) => `cp --target-directory=${m} ${o}/x`,
    (o: string, m: string) => `cp --target-directory ${m} ${o}/x`,
    (o: string, m: string) => `cp --target ${m} ${o}/x`,
    // Abbreviations GNU getopt accepts, and unknown long options, fail closed.
    (o: string, m: string) => `cp --t ${m}/.claude/ ${o}/settings.json`,
    (o: string, m: string) => `cp --ta ${m} ${o}/x`,
    (o: string, m: string) => `ln -sf --t ${m}/.claude ${o}/settings.json`,
    (o: string, m: string) => `cp --l ${m}/a.txt ${o}/hard`,
    (o: string, m: string) => `cp --li ${m}/a.txt ${o}/hard`,
    (o: string, m: string) => `cp --s ${m}/a.txt ${o}/y`,
    (o: string, m: string) => `cp --no-such-option ${m}/a.txt ${o}/y`,
    (o: string, m: string) => `cp -- ${o}/x ${m}/b.txt`,
    // A backup suffix makes the split uncertain: every operand is a write.
    (o: string, m: string) => `cp -S .bak ${m}/a.txt ${o}/y`,
    (o: string, m: string) => `cp --suffix=.bak ${m}/a.txt ${o}/y`,
    (o: string, m: string) => `ln -b ${m}/a.txt ${o}/y`,
    (_o: string, m: string) => `chmod +x ${m}/a.txt`,
    (_o: string, m: string) => `chmod 755 ${m}/a.txt`,
    (_o: string, m: string) => `chmod -w ${m}/a.txt`,
    (_o: string, m: string) => `chmod -- +x ${m}/a.txt`,
    (_o: string, m: string) => `chown user ${m}/a.txt`,
    (o: string, m: string) => `chmod --reference=${o}/r ${m}/a.txt`,
    (o: string, m: string) => `mv ${m}/a.txt ${o}/a.txt`,
  ])("a write into the main checkout stays refused: %s", (make) => {
    const command = make(posix(outside), posix(main));
    expect(bash(command, main).decision, command).toBe("human");
  });

  test("`ln -s path` links its base name in the working directory", () => {
    expect(bash(`ln -s ${posix(outside)}/x`, main).decision).toBe("human");
  });

  test("copying or linking a credential is a credential read", () => {
    for (const command of [
      `cp ${posix(keys)}/id_rsa ${posix(outside)}/k`,
      `ln -s ${posix(keys)}/id_rsa ${posix(outside)}/k`,
      `cp -t ${posix(outside)} ${posix(keys)}/server.pem`,
    ]) {
      const d = bash(command, main);
      expect(d.decision, command).toBe("human");
      expect(d.category, command).toBe("sensitive");
    }
  });

  test.skipIf(windows)("a hard link then a temp write in one script is refused", () => {
    const h = `${posix(outside)}/hard`;
    expect(bash(`ln ${posix(main)}/a.txt ${h} && echo x >> ${h}`, main).decision).toBe("human");
  });

  test("a hard link out of the main checkout is a write of its source", () => {
    for (const command of [
      `ln ${posix(main)}/a.txt ${posix(outside)}/hard`,
      `ln -f ${posix(main)}/a.txt ${posix(outside)}/hard`,
      `cp -l ${posix(main)}/a.txt ${posix(outside)}/hard`,
      `cp -al ${posix(main)} ${posix(outside)}/tree`,
      `cp --link ${posix(main)}/a.txt ${posix(outside)}/hard`,
    ])
      expect(bash(command, main).decision, command).toBe("human");
  });

  test("a hard-linked file in a scratch root is not a scratch write", () => {
    const scratch = join(root, "scratch-root");
    mkdirSync(scratch);
    const scratchProfile = parseProfile(
      JSON.stringify({ version: 1, mode: "permissive", scratchRoots: [scratch] }),
    );
    const decide = (command: string) =>
      evaluate(
        { sessionId: "t", harness: "claude", cwd: main, tool: "Bash", input: { command } },
        undefined,
        scratchProfile,
      );
    const settings = join(main, ".claude", "settings.json");
    mkdirSync(join(main, ".claude"), { recursive: true });
    writeFileSync(settings, "{}");
    const alias = join(scratch, "s");
    // First call: the link itself asks.
    expect(decide(`ln ${posix(settings)} ${posix(alias)}`).decision).toBe("human");
    // Second call, once the link exists: a write through it asks too.
    linkSync(settings, alias);
    expect(decide(`echo x > ${posix(alias)}`).decision).toBe("human");
    const r: Request = {
      sessionId: "t",
      harness: "claude",
      cwd: main,
      tool: "Write",
      input: { file_path: alias, content: "x" },
    };
    expect(evaluate(r, undefined, scratchProfile).decision).toBe("human");
    expect(decide(`echo x > ${posix(scratch)}/plain.txt`).decision).toBe("approve");
  });

  test.each([
    (m: string) => `chmod -N ${m}/a.txt`,
    (m: string) => `chmod -E ${m}/a.txt`,
    (m: string) => `chmod -C ${m}/a.txt`,
    (m: string) => `chmod -i ${m}/a.txt`,
    (m: string) => `chmod -I ${m}/a.txt`,
    (m: string) => `chmod -vN ${m}/a.txt`,
  ])("BSD chmod ACL options take no mode: %s", (make) => {
    expect(bash(make(posix(main)), main).decision).toBe("human");
  });
});

describe("git worktree remove --force", SLOW, () => {
  function scratchWorktree(name: string): string {
    const path = join(root, name);
    git(main, ["worktree", "add", "--detach", path]);
    return path;
  }

  test("approves a linked worktree in the temp directory, outside the main checkout", () => {
    const path = posix(scratchWorktree("scratch-1"));
    for (const command of [
      `git worktree remove --force ${path}`,
      `git worktree remove -f ${path}`,
      `git worktree remove --force -- ${path}`,
    ]) {
      const d = bash(command, main);
      expect(d.decision, command).toBe("approve");
      expect(d.reason).toMatch(/temp or scratch/);
    }
    expect(bash(`git -C ${posix(main)} worktree remove --force ${path}`, outside).decision).toBe(
      "approve",
    );
    // From another worktree of the same repository.
    expect(bash(`git worktree remove --force ${path}`).decision).toBe("approve");
  });

  test.each([
    ["the main worktree", () => posix(main)],
    ["a worktree inside the main checkout", () => posix(inner)],
    ["a directory that is not a worktree", () => posix(outside)],
    ["a missing path", () => `${posix(root)}/missing-wt`],
  ])("refuses %s", (_label, path) => {
    expect(bash(`git worktree remove --force ${path()}`, main).decision).toBe("human");
  });

  test("refuses extra paths, unknown options and other repositories", () => {
    const path = posix(scratchWorktree("scratch-2"));
    expect(bash(`git worktree remove --force ${path} ${posix(inner)}`, main).decision).toBe(
      "human",
    );
    expect(bash(`git worktree remove --force --quiet ${path}`, main).decision).toBe("human");
    const other = join(root, "other");
    execFileSync("git", ["init", "-b", "main", other], { stdio: "ignore" });
    expect(bash(`git worktree remove --force ${path}`, other).decision).toBe("human");
  });

  test("a second force, which removes a locked worktree, asks", () => {
    const path = scratchWorktree("scratch-locked");
    git(main, ["worktree", "lock", path]);
    for (const flags of ["-ff", "-f -f", "--force -f", "--force --force"])
      expect(bash(`git worktree remove ${flags} ${posix(path)}`, main).decision, flags).toBe(
        "human",
      );
  });

  test("refuses a worktree that holds another worktree", () => {
    const outer = scratchWorktree("scratch-4");
    git(main, ["worktree", "add", "--detach", join(outer, "nested")]);
    expect(bash(`git worktree remove --force ${posix(outer)}`, main).decision).toBe("human");
  });

  test.skipIf(windows)("refuses after a command that can create symlinks", () => {
    const path = posix(scratchWorktree("scratch-3"));
    expect(
      bash(`ln -s ${posix(outside)} ${posix(outside)}/l; git worktree remove --force ${path}`, main)
        .decision,
    ).toBe("human");
  });

  test("plain prune is approved; prune with an expiry is not", () => {
    expect(bash("git worktree prune", main).decision).toBe("approve");
    expect(bash("git worktree prune -v", main).decision).toBe("approve");
    expect(bash("git worktree prune --expire now", main).decision).toBe("human");
  });
});

describe("bare credential operands (#33)", SLOW, () => {
  test.each([
    "cat id_rsa",
    "cat credentials",
    "cp credentials copy",
    "grep x secrets.json",
    "sed -n 1p .env",
    "head server.pem",
    "tail tls.key",
    "head -n 5 tls.key",
    "grep -e x id_rsa",
    "cat ./id_rsa",
    "cat *.pem",
    "cat id_*",
    "cat *",
    "cat .*",
    "wc -c src/../id_rsa",
    "less --file=id_rsa",
  ])("refuses %s from the containing directory", (command) => {
    const d = bash(command, keys);
    expect(d.decision).toBe("human");
    expect(d.category).toBe("sensitive");
  });

  test.each([
    "cat notes.txt",
    "grep -rn id_rsa notes.txt",
    "grep -e credentials notes.txt",
    "sed s/secret/x/ notes.txt",
    "echo id_rsa",
    "cat src/secrets.ts",
    "cat src/*.ts",
    "ls src",
  ])("approves %s", (command) => {
    expect(bash(command, keys).decision).toBe("approve");
  });

  test.skipIf(windows)("a symlink to a credential is judged by its target", () => {
    symlinkSync(join(keys, "id_rsa"), join(outside, "innocent"));
    expect(bash("cat innocent", outside).category).toBe("sensitive");
  });

  test("a glob in a directory component is expanded too", () => {
    const home = join(root, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "known"), "x");
    mkdirSync(join(home, "docs"));
    writeFileSync(join(home, "docs", "a.md"), "x");
    for (const command of ["cat .*/*", "cat .s*/*", `cat ${posix(home)}/.s*/*`, "cat */../.ssh/*"])
      expect(bash(command, home).category, command).toBe("sensitive");
    expect(bash("cat */*.md", home).decision).toBe("approve");
  });

  test("zsh recursive `**` fails closed", () => {
    for (const command of ["cat **/.s*/*", "cat **/id*", "cat src/***/x"])
      expect(bash(command, keys).category, command).toBe("sensitive");
  });

  test.skipIf(windows)("a pattern option is found by parsing, not by the previous word", () => {
    symlinkSync(join(keys, "id_rsa"), join(outside, "plain"));
    for (const command of [
      "rg -e -g ./plain",
      "rg -e --glob ./plain",
      "grep x -- --include ./plain",
      "find . -name x -- -name ./plain",
      // Another option's value is consumed first.
      "rg x -r -g ./plain",
      "rg x -A -g ./plain",
      "rg x --context-separator -g ./plain",
      "grep x --label --include ./plain",
      "grep x -m --include ./plain",
      "find . -newer -name ./plain",
      "find . -printf -name ./plain",
    ])
      expect(bash(command, outside).category, command).toBe("sensitive");
    expect(bash("rg x -g ./plain", outside).decision).toBe("approve");
  });

  test("a glob over more entries than the budget fails closed", () => {
    const big = join(root, "big");
    mkdirSync(big);
    for (let i = 0; i < 5001; i++) writeFileSync(join(big, `f${i}.txt`), "");
    expect(bash("cat *", big).category).toBe("sensitive");
  });

  test.skipIf(windows)("an unresolvable entry fails closed", () => {
    const loop = join(root, "loop");
    mkdirSync(loop);
    symlinkSync("self", join(loop, "self"));
    writeFileSync(join(loop, "zz.txt"), "");
    expect(bash("cat *", loop).category).toBe("sensitive");
  });

  test("a file-name pattern option is judged by name only", () => {
    expect(bash("find . -name '*.json'", keys).decision).toBe("approve");
    expect(bash("grep -r x --include=*.json .", keys).decision).toBe("approve");
    expect(bash("find . -name '*.pem'", keys).category).toBe("sensitive");
  });

  test("a file in a credential directory is sensitive by its resolved path", () => {
    const ssh = join(outside, ".ssh");
    mkdirSync(ssh);
    writeFileSync(join(ssh, "config"), "x");
    expect(bash("cat config", ssh).category).toBe("sensitive");
  });
});
