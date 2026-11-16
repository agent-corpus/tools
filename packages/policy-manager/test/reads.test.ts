import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { evaluate, PLAIN_READ } from "../src/policy.js";
import { parseProfile, strictProfile } from "../src/profile.js";
import { plainRead, readable } from "../src/reads.js";
import type { Request } from "../src/types.js";

let root: string, repo: string, outside: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reads-test-")));
  repo = join(root, "repo");
  outside = join(root, "outside");
  mkdirSync(outside);
  for (const dir of [".claude/agents", ".github/workflows", ".agent-config", ".codex", "src"])
    mkdirSync(join(repo, dir), { recursive: true });
  for (const file of [
    ".claude/agents/a.md",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".github/workflows/ci.yml",
    ".agent-config/x.md",
    ".codex/config.toml",
    "AGENTS.md",
    "CLAUDE.md",
    ".env",
    "src/app.ts",
  ])
    writeFileSync(join(repo, file), "x");
  writeFileSync(join(outside, "notes.txt"), "x");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const bash = (command: string, cwd = repo): Request => ({
  sessionId: "s",
  harness: "claude",
  cwd,
  tool: "Bash",
  input: { command },
});
const read = (file_path: string): Request => ({
  sessionId: "s",
  harness: "claude",
  cwd: repo,
  tool: "Read",
  input: { file_path },
});
const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));

describe("plain reads under protected paths are approved", () => {
  test.each([
    "cat .claude/agents/a.md",
    "cat AGENTS.md CLAUDE.md",
    "head -20 .github/workflows/ci.yml",
    "tail -n 5 .agent-config/x.md",
    "ls -la .claude .github",
    "ls",
    "grep -rn foo .claude/agents",
    "rg -n 'foo bar' .agent-config",
    "find .github -name '*.yml'",
    "cat .claude/agents/a.md | grep x | head -3",
    "grep -n x AGENTS.md 2>/dev/null",
    "grep -n x AGENTS.md 2>&1 | head",
    "cd .claude && cat agents/a.md",
    "git grep -n foo origin/main -- .github",
    "cat < AGENTS.md",
    "sed -n 1p AGENTS.md",
    "git show HEAD:AGENTS.md | sed 's#a#b#' | sort | uniq -c | head",
  ])("%s", (command) => {
    expect(plainRead(bash(command)), command).toBe(true);
    for (const profile of [strictProfile, permissive])
      expect(evaluate(bash(command), undefined, profile).decision, command).toBe("approve");
  });

  test("the Read tool", () => {
    for (const file of [".claude/agents/a.md", "AGENTS.md", ".github/workflows/ci.yml"])
      expect(plainRead(read(join(repo, file))), file).toBe(true);
    expect(evaluate(read(join(repo, "AGENTS.md")), undefined, strictProfile).reason).not.toBe(
      "Protected path requires human approval",
    );
  });
});

describe("anything else is not a plain read", () => {
  test.each([
    // Secrets and harness settings that can hold tokens.
    "cat .env",
    "cat .claude/settings.json",
    "cat .claude/settings.local.json",
    "head .codex/config.toml",
    "cat ~/.aws/credentials",
    "cat .git/config",
    "grep -r token .env",
    // Writes and redirections.
    "cat AGENTS.md > copy.md",
    "cat AGENTS.md >> .claude/agents/a.md",
    "cat AGENTS.md | tee out.md",
    "grep x AGENTS.md > /dev/null",
    // Substitution, variables, globs, here-documents.
    "cat $(echo AGENTS.md)",
    "cat `echo AGENTS.md`",
    "cat $F",
    "cat .claude/*",
    "cat <<EOF\nx\nEOF",
    // Programs, options and pipes that run something.
    "find . -exec rm {} ;",
    "find . -delete",
    "find . -name x -execdir sh -c x ;",
    "rg --pre ./x foo .",
    "cat AGENTS.md | sh",
    "cat AGENTS.md | bash",
    "cat AGENTS.md | xargs rm",
    "git grep -O vim foo",
    "X=1 cat AGENTS.md",
    "cat AGENTS.md &",
    // Outside a checkout, temp and scratch roots: the user's agent history and home config.
    "cat ~/.claude/history.jsonl",
    "cat ~/.claude/projects/x/s.jsonl",
    "head ~/.codex/sessions/2026/x.jsonl",
    "cat ~/.local/share/x/data",
    // Options that run a program, abbreviations, and any option not on the allow-list.
    "rg --hostname-bin ./x.sh --hyperlink-format=file foo",
    "rg --hostname-bin=./x.sh foo",
    "rg --pre ./x.sh foo",
    "rg -uuu TOKEN",
    "rg --hidden TOKEN",
    "rg --no-ignore TOKEN",
    "git grep --open-files=sh foo",
    "git grep --open-files-in-pager=sh foo",
    "git grep -Osh foo",
    "git grep --untracked foo",
    "git grep --no-index foo",
    "grep --unknown-option foo AGENTS.md",
    "find . -newerXY x",
    // A recursive search that can reach a secret file.
    "grep -r TOKEN .",
    "grep -rn . .",
    "grep -R x .claude",
    "rg TOKEN .claude",
  ])("%s", (command) => {
    expect(plainRead(bash(command)), command).toBe(false);
  });

  test("a read run from outside a checkout", () => {
    expect(plainRead(bash("ls", homedir()))).toBe(false);
    expect(plainRead(read(join(repo, ".claude", "settings.json")))).toBe(false);
    expect(plainRead(read(join(repo, ".env")))).toBe(false);
  });

  test("the plain-read reason is only for approvals", () => {
    expect(evaluate(bash("cat .env"), undefined, permissive).reason).not.toBe(PLAIN_READ);
  });
});

describe("recursive searches", () => {
  test("a search that excludes the secrets, or cannot reach them, is a plain read", () => {
    expect(plainRead(bash("grep -rn foo src"))).toBe(true);
    expect(plainRead(bash("grep -rn foo .claude/agents"))).toBe(true);
    expect(
      plainRead(
        bash(
          "grep -rn foo . --exclude=.env '--exclude=settings*.json' --exclude=config.toml --exclude-dir=.git",
        ),
      ),
    ).toBe(true);
    // ripgrep skips hidden files: `.env` and `.claude` are not reached.
    expect(plainRead(bash("rg foo src"))).toBe(true);
    // git grep reads tracked files only, and none is a secret here.
    expect(plainRead(bash("git grep -n foo -- '**/*.md'"))).toBe(true);
    expect(plainRead(bash("git grep -n foo -- ':(glob).github/**'"))).toBe(true);
  });
});

describe("chains of a read-only prefix and a command approved on its own", () => {
  test.each([
    "git status && cat AGENTS.md",
    "git log --oneline -3; git grep -n foo -- '**/*.md'",
    "ls .claude && grep -n x .claude/agents/a.md",
  ])("%s is approved", (command) => {
    for (const profile of [strictProfile, permissive])
      expect(evaluate(bash(command), undefined, profile).decision, command).toBe("approve");
  });
  test.each([
    "git status && cat .env",
    "git status && cat AGENTS.md | sh",
    "touch x.txt && cat .env",
    "cat AGENTS.md > out.md && cat AGENTS.md",
    "git status && $(echo cat) AGENTS.md",
  ])("%s is not", (command) => {
    expect(evaluate(bash(command), undefined, strictProfile).decision, command).not.toBe("approve");
  });
});

describe("read-only prefixes cannot read secrets", () => {
  test.each([
    "grep -r TOKEN . && git status",
    "cat .env; git status",
    "sort .env | uniq; git status",
  ])("%s is not approved", (command) => {
    expect(evaluate(bash(command), undefined, strictProfile).decision).not.toBe("approve");
  });
  test("a sed line range in the prefix is a read", () => {
    expect(
      evaluate(bash("sed -n 1,2p AGENTS.md; cat AGENTS.md"), undefined, strictProfile).decision,
    ).toBe("approve");
  });
});

describe("read-only prefixes take only listed options", () => {
  test.each([
    "git show HEAD:AGENTS.md --output=/tmp/nobody/.zshrc && ls",
    "git diff --output=/tmp/nobody/.zshrc HEAD~0 && ls",
    "git diff --output=../outside.txt && ls",
    "git log --output=x.txt && ls",
    "git diff --ext-diff && ls",
    "sort -o out.txt AGENTS.md && ls",
    "sort --compress-program=sh AGENTS.md && ls",
    "uniq AGENTS.md out.txt && ls",
    "sed -n 1p AGENTS.md -i && ls",
    "git fetch origin +pull/1/head:refs/heads/x && ls",
    "date -s 2020-01-01 && ls",
  ])("%s is not approved", (command) => {
    expect(evaluate(bash(command), undefined, strictProfile).decision, command).not.toBe("approve");
  });
  test.each([
    "git log --oneline -3 && cat AGENTS.md",
    "git diff --stat && ls",
    "git status -sb; git show --stat && cat AGENTS.md",
    "sort -u AGENTS.md | uniq -c; ls",
  ])("%s is approved", (command) => {
    expect(evaluate(bash(command), undefined, strictProfile).decision, command).toBe("approve");
  });
});

describe("one path rule for plain reads and read-only prefixes", () => {
  // The node binary exists everywhere and is outside any checkout, temp and scratch root.
  const elsewhere = process.execPath.replace(/\\/g, "/");
  test.each([
    "~/.claude/history.jsonl",
    "~/.claude/projects/x/s.jsonl",
    "~/.claude/shell-snapshots/x.sh",
    "~/.codex/sessions/2026/x.jsonl",
    "~/.codex/history.jsonl",
    "~/.copilot/session-state/x.json",
    "~/.config/github-copilot/apps.json",
    "~/.local/state/x",
    "~/.zsh_history",
  ])("%s is not readable, by the Read tool or cat", (path) => {
    const full = join(homedir(), path.slice(2));
    expect(readable(repo, full)).toBe(false);
    expect(plainRead(read(full))).toBe(false);
    expect(plainRead(bash(`cat ${path}`))).toBe(false);
  });
  test("Claude Code's auto-memory is readable, CLAUDE_CONFIG_DIR included", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(
        readable(repo, join(homedir(), ".claude", "projects", "x", "memory", "MEMORY.md")),
      ).toBe(true);
      process.env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude-alt");
      expect(
        readable(repo, join(homedir(), ".claude-alt", "projects", "x", "memory", "a.md")),
      ).toBe(true);
      expect(readable(repo, join(homedir(), ".claude-alt", "projects", "x", "s.jsonl"))).toBe(
        false,
      );
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
  test("a checkout, temp and a scratch root are readable", () => {
    expect(readable(repo, ".claude/agents/a.md")).toBe(true);
    expect(readable(repo, join(outside, "notes.txt"))).toBe(true);
    // Built from the home directory so the drive matches on Windows.
    const scratch = join(homedir(), "pm-scratch-root");
    expect(readable(homedir(), join(scratch, "x"), [scratch])).toBe(true);
    expect(readable(homedir(), join(homedir(), "pm-other-root", "x"), [scratch])).toBe(false);
  });
  test.each(["jq .", "cut -c1-200", "wc -l", "sort", "nl", "diff AGENTS.md"])(
    "a read-only prefix `%s` names only readable files",
    (program) => {
      expect(
        evaluate(bash(`${program} ${elsewhere} && ls`), undefined, strictProfile).decision,
      ).not.toBe("approve");
      expect(evaluate(bash(`${program} AGENTS.md && ls`), undefined, strictProfile).decision).toBe(
        "approve",
      );
    },
  );
});

describe("a first cd that cannot fail leaves only its target", () => {
  const to = () => repo.replace(/\\/g, "/");
  test.each([
    (r: string) => `cd ${r} && git grep -n x`,
    (r: string) => `cd ${r}; cat AGENTS.md | head -5`,
    (r: string) => `cd ${r} && git log --oneline -1; git grep -n x -- 'src/**' | head -3`,
  ])("approved from outside any checkout: %s", (make) => {
    const command = make(to());
    expect(evaluate(bash(command, homedir()), undefined, strictProfile).decision, command).toBe(
      "approve",
    );
  });
  test("a later or relative cd keeps the old directory possible", () => {
    expect(plainRead(bash(`ls; cd ${to()}; cat AGENTS.md`, homedir()))).toBe(false);
    expect(plainRead(bash(`cd ${to()} && ls || cat AGENTS.md`, homedir()))).toBe(false);
    const rel = relative(homedir(), repo).replace(/\\/g, "/");
    expect(plainRead(bash(`cd ${rel}; cat AGENTS.md`, homedir()))).toBe(false);
  });
});
