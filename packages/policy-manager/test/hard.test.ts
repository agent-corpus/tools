import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hookResponse } from "../src/adapters.js";
import { hardRule, hardRules } from "../src/hard.js";
import { evaluate } from "../src/policy.js";
import { parseProfile, strictProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

// Hard human items: credentials, protected configuration, unrecoverable loss and humanPatterns.
// They are never sent to the classifier, and no classification approves them.
const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
let root: string, repo: string, worktree: string, other: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "ignore",
  });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hard-test-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "commit", "--allow-empty", "-m", "init");
  worktree = join(repo, ".worktrees", "feat");
  other = join(repo, ".worktrees", "other");
  git(repo, "worktree", "add", "-b", "feat/a", worktree);
  git(repo, "worktree", "add", "-b", "feat/b", other);
  // A branch with a commit no remote has: deleting it loses work.
  git(repo, "branch", "unmerged");
  git(repo, "worktree", "add", join(root, "u"), "unmerged");
  git(join(root, "u"), "commit", "--allow-empty", "-m", "work");
  git(repo, "worktree", "remove", join(root, "u"));
  // Repository aliases; linked worktrees share them.
  git(repo, "config", "alias.pf", "push --force");
  git(repo, "config", "alias.cl", "clean -fd");
  git(repo, "config", "alias.shpf", "!git push -f origin feat/a");
  git(repo, "config", "alias.st", "status");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function session(profile = permissive, harness: Request["harness"] = "claude") {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  let runs = 0;
  const s = new PolicySession(directory, harness, "s1", profile, undefined, {
    classify: async (cli) => {
      runs++;
      return {
        ok: true,
        cli,
        model: "stub",
        latencyMs: 1,
        verdict: {
          category: "worktree-write",
          confidence: 0.99,
          recoverable: true,
          rationale: "x",
        },
      };
    },
    nativeRules: () => undefined,
  });
  return { directory, s, runs: () => runs };
}
const shell = (command: string, cwd = worktree): Request => ({
  sessionId: "s1",
  harness: "claude",
  cwd,
  tool: "Bash",
  input: { command },
});
const write = (file_path: string, cwd = worktree): Request => ({
  sessionId: "s1",
  harness: "claude",
  cwd,
  tool: "Write",
  input: { file_path, content: "x" },
});

describe("hard items ask a person in every harness, without the classifier", () => {
  const settings = (...parts: string[]) => join(homedir(), ...parts);
  const asks: Array<[string, string, () => Request]> = [
    ["force-push", "--force", () => shell("git push --force origin feat/a")],
    ["force-push", "--mirror", () => shell("git push --mirror origin")],
    ["force-push", "a + refspec", () => shell("git push origin +feat/a")],
    ["force-push", "an unparsed form", () => shell("git push -f origin {feat/a,x}")],
    ["delete-unmerged-branch", "git branch -D", () => shell("git branch -D unmerged", repo)],
    [
      "delete-unmerged-branch",
      "a remote deletion",
      () => shell("git push origin --delete unmerged", repo),
    ],
    [
      "remove-worktree-force",
      "worktree remove --force",
      () => shell(`git worktree remove --force ${other}`, repo),
    ],
    ["git-clean", "git clean -fd", () => shell("git clean -fd")],
    [
      "harness-settings",
      "~/.claude/settings.json",
      () => write(settings(".claude", "settings.json")),
    ],
    [
      "harness-settings",
      "~/.claude/settings.local.json",
      () => write(settings(".claude", "settings.local.json")),
    ],
    ["harness-settings", "~/.codex/hooks.json", () => write(settings(".codex", "hooks.json"))],
    ["harness-settings", "~/.codex/config.toml", () => write(settings(".codex", "config.toml"))],
    [
      "harness-settings",
      "~/.codex/rules",
      () => write(settings(".codex", "rules", "default.rules")),
    ],
    [
      "harness-settings",
      "~/.copilot/hooks",
      () => write(settings(".copilot", "hooks", "policy-manager.json")),
    ],
    [
      "harness-settings",
      "a shell redirect",
      () => shell("echo '{}' > ~/.claude/settings.json", repo),
    ],
    ["harness-settings", "~/.claude/hooks/x.sh", () => write(settings(".claude", "hooks", "x.sh"))],
    ["harness-settings", "~/.claude.json", () => write(settings(".claude.json"))],
    ["harness-settings", "~/.codex/hooks/x.sh", () => write(settings(".codex", "hooks", "x.sh"))],
    [
      "harness-settings",
      "~/.copilot/config.json",
      () => write(settings(".copilot", "config.json")),
    ],
    [
      "policy-profile",
      "the profile path",
      () => write(join(homedir(), ".config", "agent-corpus", "policy-manager", "policy.json")),
    ],
    ["credential-read", "a credential file", () => shell("cat ~/.aws/credentials")],
  ];
  test.each(asks)("%s (%s)", async (rule, _, make) => {
    const r = make();
    for (const harness of ["claude", "copilot", "codex"] as const) {
      const { s, runs } = session(permissive, harness);
      const d = await s.decide({ ...r, harness }, "PreToolUse");
      expect(d.decision).toBe("human");
      expect(d.hard).toBeDefined();
      if (d.hard !== "protected") expect(d.hard).toBe(rule);
      expect(runs()).toBe(0);
      const out = JSON.stringify(hookResponse(harness, "PreToolUse", d));
      if (harness === "codex") {
        expect(out).toContain('"permissionDecision":"deny"');
        expect(out).toContain("approve --last");
      } else expect(out).toContain('"ask"');
      expect(hookResponse(harness, "PermissionRequest", d)).toEqual({});
      expect(s.latestHumanDecision()?.requestHash).toBe(d.requestHash);
    }
  });

  test("protected repository paths are hard too", async () => {
    for (const path of [join(worktree, ".github", "hooks", "x.json"), join(repo, "AGENTS.md")]) {
      const { s, runs } = session();
      const d = await s.decide(write(path, repo), "PreToolUse");
      expect(d).toMatchObject({ decision: "human" });
      expect(d.hard).toBeDefined();
      expect(runs()).toBe(0);
    }
  });

  test("humanPatterns are hard", async () => {
    const profile = parseProfile(
      JSON.stringify({ version: 1, mode: "permissive", humanPatterns: ["^terraform apply"] }),
    );
    const { s, runs } = session(profile);
    const d = await s.decide(shell("terraform apply"), "PreToolUse");
    expect(d).toMatchObject({ decision: "human", hard: "human-patterns" });
    expect(runs()).toBe(0);
  });

  test("approve --last and --session keep working for a hard item", () => {
    const { s } = session();
    const r = shell("git push --force origin feat/a");
    const d = s.review(r, undefined, "PreToolUse");
    expect(s.latestHumanDecision()?.requestHash).toBe(d.requestHash);
    expect(s.grant(d.requestHash, true).granted).toBe(true);
    for (const phase of ["PreToolUse", "PermissionRequest"])
      expect(s.review(r, undefined, phase).decision).toBe("approve");
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("human");
  });

  test("an agent running approve itself is hard", () => {
    const { s } = session();
    const d = s.review(shell("policy-manager approve --last"), undefined, "PreToolUse");
    expect(d).toMatchObject({ decision: "human", hard: "self-approve", userOnly: true });
  });
});

describe("quoted, indirect and nested forms do not escape the hard list", () => {
  const forms: Array<[string, string]> = [
    ["force-push", "'git' push --force origin x"],
    ["force-push", "git 'push' --force origin x"],
    ["force-push", "git push '--force' origin x"],
    ["force-push", 'git push --for"ce" origin x'],
    ["force-push", "\\git push -f origin x"],
    ["force-push", "GIT=git; $GIT push -f origin x"],
    ["force-push", "x=push; git $x --force origin"],
    ["force-push", 'x="push --force"; git $x origin'],
    ["force-push", "git -c alias.p=push p --force origin"],
    ["force-push", "git $(echo push) --force origin"],
    ["force-push", "git `echo push` --force origin"],
    ["force-push", 'git "$(echo push)" --force origin'],
    ["force-push", "GIT_EXEC_PATH=/tmp/x git push origin x --force"],
    ["force-push", "git --exec-path=/tmp/x push -f origin x"],
    ["force-push", 'eval git push "--for""ce" origin x'],
    ["force-push", "eval 'git pu''sh --force origin x'"],
    ["force-push", 'X=--force; eval "git push $X origin x"'],
    ["force-push", "bash -c 'git push --force origin x'"],
    ["force-push", 'sh -c "git push -f origin x" && echo done'],
    ["force-push", "echo ok; (cd /tmp && git push --force origin x)"],
    ["force-push", "env -i git push --mirror origin"],
    ["force-push", "sudo -u me git push origin +x"],
    ["delete-unmerged-branch", "git update-ref -d refs/heads/x"],
    ["delete-unmerged-branch", "git branch -D ${BR}"],
    ["delete-unmerged-branch", "git 'branch' '-D' x"],
    ["delete-unmerged-branch", "git push origin ':x'"],
    ["git-clean", "git 'clean' -fd"],
    ["git-clean", "git clean -fd {a,b}"],
    ["remove-worktree-force", "git worktree remove '--force' ../x"],
    ["harness-settings", "echo x > ~/.claude/'settings.json'"],
    ["harness-settings", "cd ~/.claude && echo x > settings.json"],
    ["harness-settings", 'cd "$HOME/.claude" && echo x > settings.json'],
    ["harness-settings", "cp /tmp/a ~/.codex/'config.toml'"],
    ["harness-settings", "tee ~/.copilot/hooks/x.json < /tmp/a"],
    ["harness-settings", "cd ~ && mv /tmp/a .claude.json"],
    ["policy-profile", "cd ~/.config/agent-corpus/policy-manager && echo '{}' > policy.json"],
    // Commands the scanner reads as data but that still run: the plain-text reading catches them.
    ["force-push", "echo 'git push -f origin x' | sh"],
    ["force-push", "printf '%s\\n' 'git push --force origin x' | bash"],
    ["force-push", "bash <(echo 'git push -f origin x')"],
    ["force-push", "source <(echo 'git push -f origin x')"],
    ["force-push", "find . -exec git push -f origin x ;"],
    ["force-push", `node -e "require('child_process').execSync('git push -f origin x')"`],
    ["force-push", `python3 -c "import os; os.system('git push -f origin x')"`],
    ["force-push", "alias gp='git push --force'; gp origin x"],
    ["force-push", "bash <<< 'git push --force origin x'"],
    ["git-clean", "echo 'git clean -fdx' | sh"],
    ["harness-settings", `python3 -c "open('/x/.claude/settings.json','w')"`],
    // Push options known only at run time, or a configured forced push.
    ["force-push", "git push $ARGS origin x"],
    ["force-push", "git push ${F:- -f} origin x"],
    ["force-push", "git push origin x $(echo -f)"],
    ["force-push", "git push origin $B:+main"],
    ["force-push", "F=-f; git push $F origin x"],
    ["force-push", "git -c remote.origin.push=+refs/heads/*:refs/heads/* push origin"],
    ["force-push", "git -c remote.origin.mirror=true push origin"],
  ];
  const profiles = [
    ["strict", strictProfile],
    ["permissive", permissive],
  ] as const;
  for (const [mode, profile] of profiles)
    test.each(forms)(`${mode}: %s for %s`, (rule, command) => {
      const r = shell(command, repo);
      const d = session(profile).s.review(r, undefined, "PreToolUse");
      expect(d.decision, command).toBe("human");
      expect(d.hard, command).toBeDefined();
      expect(hardRules(r, d), command).toContain(rule);
    });

  test.each([
    "git status",
    "git log --oneline -5",
    "echo $(git rev-parse HEAD)",
    "git commit -m 'force push later, then clean up'",
    "npm run build -- --force",
  ])("ordinary commands are not hard: %s", (command) => {
    for (const [, profile] of profiles) {
      const d = session(profile).s.review(shell(command), undefined, "PreToolUse");
      expect(d.hard, command).toBeUndefined();
    }
  });
});

describe("a classification never approves a hard item", () => {
  test.each([
    "git push -f origin {feat/a,x}",
    "git clean -fd {a,b}",
    "git branch -D ${BR}",
    "git push origin --delete ${BR}",
  ])("%s", async (command) => {
    const { s, runs } = session();
    const r = shell(command);
    const d = s.review(r, undefined, "PreToolUse");
    expect(d.decision).toBe("human");
    expect(d.needsClassification).toBeFalsy();
    const ai = {
      requestHash: d.requestHash,
      category: "worktree-write" as const,
      confidence: 0.99,
      recoverable: true,
    };
    // Not offered for classification, and a record for it approves nothing.
    expect(() => s.classify(ai)).toThrow();
    expect(s.review(r, ai, "PreToolUse").decision).toBe("human");
    expect(evaluate(r, ai, permissive).decision).toBe("human");
    expect((await s.decide(r, "PreToolUse")).decision).toBe("human");
    expect(runs()).toBe(0);
  });
});

test("a long run of slashes in hook input is judged in linear time", () => {
  const long = `/${"/".repeat(100_000)}x`;
  const base = { ...evaluate(shell("ls"), undefined, permissive), decision: "human" as const };
  const started = Date.now();
  hardRule(shell(`echo ${long}/ > ${long}//`), base);
  hardRule(write(`${long}/`), base);
  expect(Date.now() - started).toBeLessThan(2000);
});

describe("git aliases are judged by what they run", () => {
  const profiles = [
    ["strict", strictProfile],
    ["permissive", permissive],
  ] as const;
  for (const [mode, profile] of profiles) {
    test.each([
      ["force-push", "git pf origin feat/a"],
      ["force-push", "git 'pf' origin feat/a"],
      ["git-clean", "git cl"],
      ["force-push", "git shpf"],
    ])(`${mode}: %s through an alias: %s`, (rule, command) => {
      const d = session(profile).s.review(shell(command), undefined, "PreToolUse");
      expect(d, command).toMatchObject({ decision: "human", hard: rule });
    });

    test(`${mode}: an unknown subcommand that is not an alias is never approved`, () => {
      for (const command of ["git frobnicate-nothing --force", "git frobnicate-nothing"]) {
        const d = session(profile).s.review(shell(command), undefined, "PreToolUse");
        expect(d.decision, command).not.toBe("approve");
      }
    });
  }

  test("an ordinary alias is approved as before", () => {
    const d = session().s.review(shell("git st"), undefined, "PreToolUse");
    expect(d.decision).toBe("approve");
  });
});
