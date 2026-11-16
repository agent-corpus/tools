import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "@agent-corpus/audit-log";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { hookOutput, hookResponse } from "../src/adapters.js";
import type { ClassifierResult } from "../src/classifier.js";
import {
  bashRuleMatches,
  clearNativeRuleCache,
  codexInvocations,
  nativeRules,
  parseCodexRules,
  pathGlob,
  wildcard,
} from "../src/nativerules.js";
import { parseProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

let root: string, repo: string, worktree: string, claudeHome: string, codexHome: string;
const env = { ...process.env };
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "native-rules-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      stdio: "ignore",
    });
  git("init", "-b", "main");
  git("commit", "--allow-empty", "-m", "init");
  worktree = join(repo, ".worktrees", "feat");
  git("worktree", "add", "-b", "feat/a", worktree);
  claudeHome = join(root, "claude-home");
  codexHome = join(root, "codex-home");
  mkdirSync(claudeHome);
  mkdirSync(join(codexHome, "rules"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
});
afterAll(() => {
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = env.CODEX_HOME;
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  for (const path of [
    join(claudeHome, "settings.json"),
    join(repo, ".claude"),
    join(worktree, ".claude"),
    join(codexHome, "rules"),
    join(codexHome, "config.toml"),
    join(worktree, ".codex"),
  ])
    rmSync(path, { recursive: true, force: true });
  mkdirSync(join(codexHome, "rules"));
  clearNativeRuleCache();
});

const claudeSettings = (
  permissions: Record<string, string[]>,
  path = join(claudeHome, "settings.json"),
) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ permissions }));
  clearNativeRuleCache();
};
const bash = (
  command: string,
  harness: Request["harness"] = "claude",
  cwd = worktree,
): Request => ({
  sessionId: "s1",
  harness,
  cwd,
  tool: harness === "codex" ? "exec_command" : "Bash",
  input: { command },
});

describe("Claude Code rule matching, with the examples from the permissions docs", () => {
  // https://code.claude.com/docs/en/permissions
  test.each([
    ["npm run build", "npm run build", true],
    ["npm run build", "npm run build --watch", false],
    ["ls *", "ls -la", true],
    ["ls *", "ls", true],
    ["ls *", "lsof", false],
    ["ls*", "lsof", true],
    ["ls:*", "ls -la", true],
    ["ls:*", "ls", true],
    ["ls:*", "lsof", false],
    ["* --help *", "npm --help x", true],
    ["* --help *", "npm --help", false],
    ["*", "anything at all", true],
    ["git commit *", "git commit -m msg", true],
    ["git commit *", "git push", false],
  ])("Bash(%s) against %s: %s", (rule, text, expected) =>
    expect(bashRuleMatches(rule, text)).toBe(expected),
  );

  test("matching cost stays bounded on hostile input", () => {
    const started = Date.now();
    wildcard(`${"*a".repeat(200)}b`, "a".repeat(5000));
    pathGlob(`/${"**/a/".repeat(50)}b`, `/${"a/".repeat(2000)}c`);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("deny, then ask, then allow; the first match decides", () => {
    claudeSettings({
      allow: ["Bash(git *)"],
      ask: ["Bash(git push *)"],
      deny: ["Bash(git push --force *)"],
    });
    expect(nativeRules(bash("git status"))?.verdict).toBe("allow");
    expect(nativeRules(bash("git push origin x"))?.verdict).toBe("ask");
    expect(nativeRules(bash("git push --force origin x"))?.verdict).toBe("deny");
    expect(nativeRules(bash("npm test"))).toBeUndefined();
  });

  test("compound commands: every subcommand must be allowed; deny and ask apply to any", () => {
    claudeSettings({ allow: ["Bash(npm *)", "Bash(git status)"], deny: ["Bash(curl *)"] });
    expect(nativeRules(bash("npm test && git status"))?.verdict).toBe("allow");
    for (const separator of ["&&", "||", ";", "|", "|&", "&", "\n"])
      expect(nativeRules(bash(`npm test ${separator} git status`))?.verdict, separator).toBe(
        "allow",
      );
    expect(nativeRules(bash("npm test && rm -rf x"))).toBeUndefined();
    // Unparseable: a trailing operator.
    expect(nativeRules(bash("npm test &&"))).toBeUndefined();
    // Deny reaches into substitutions and subshells.
    expect(nativeRules(bash("npm test $(curl -s https://example.com)"))?.verdict).toBe("deny");
    expect(nativeRules(bash("(cd x && curl https://example.com)"))?.verdict).toBe("deny");
  });

  test("wrappers are stripped; exec wrappers and find -exec always prompt", () => {
    claudeSettings({ allow: ["Bash(npm test *)", "Bash(find *)", "Bash(watch *)"] });
    for (const wrapped of [
      "timeout 30 npm test x",
      "time npm test x",
      "nice -n 5 npm test x",
      "nohup npm test x",
      "stdbuf -oL npm test x",
      "command npm test x",
    ])
      expect(nativeRules(bash(wrapped))?.verdict, wrapped).toBe("allow");
    expect(nativeRules(bash("find . -name x"))?.verdict).toBe("allow");
    expect(nativeRules(bash("find . -delete"))).toBeUndefined();
    expect(nativeRules(bash("find . -exec rm {} ;"))).toBeUndefined();
    expect(nativeRules(bash("watch npm test x"))).toBeUndefined();
  });

  test("an allow rule needs literal words; deny and ask match past assignments", () => {
    claudeSettings({ allow: ["Bash(echo *)"], deny: ["Bash(rm *)"] });
    expect(nativeRules(bash("echo hi"))?.verdict).toBe("allow");
    expect(nativeRules(bash("echo $HOME"))).toBeUndefined();
    expect(nativeRules(bash("echo hi > out.txt"))).toBeUndefined();
    expect(nativeRules(bash("echo hi 2>/dev/null"))?.verdict).toBe("allow");
    expect(nativeRules(bash("X=1 echo hi"))).toBeUndefined();
    expect(nativeRules(bash("X=1 rm -rf y"))?.verdict).toBe("deny");
  });

  test("bare tool names and Bash(*) match every command", () => {
    claudeSettings({ ask: ["Bash"] });
    expect(nativeRules(bash("ls"))?.verdict).toBe("ask");
    claudeSettings({ allow: ["Bash(*)"] });
    expect(nativeRules(bash("ls && rm -rf x"))?.verdict).toBe("allow");
  });

  test("Read and Edit path rules with the documented prefixes", () => {
    const file = (tool: string, path: string): Request => ({
      sessionId: "s1",
      harness: "claude",
      cwd: worktree,
      tool,
      input: { file_path: path },
    });
    claudeSettings({
      deny: ["Read(.env)", "Edit(//etc/**)", "Read(~/.ssh/**)"],
      allow: ["Edit(./src/**)", "Edit(/docs/*.md)"],
    });
    expect(nativeRules(file("Read", join(worktree, ".env")))?.verdict).toBe("deny");
    expect(nativeRules(file("Read", join(worktree, "a", "b", ".env")))?.verdict).toBe("deny");
    expect(nativeRules(file("Read", join(homedir(), ".ssh", "id_rsa")))?.verdict).toBe("deny");
    expect(nativeRules(file("Write", "/etc/hosts"))?.verdict).toBe("deny");
    expect(nativeRules(file("Edit", join(worktree, "src", "a", "b.ts")))?.verdict).toBe("allow");
    // Edit rules cover Write; `/path` is relative to the project of the settings.
    expect(nativeRules(file("Write", join(worktree, "src", "c.ts")))?.verdict).toBe("allow");
    expect(nativeRules(file("Edit", join(worktree, "docs", "x.md")))?.verdict).toBe("allow");
    expect(nativeRules(file("Edit", join(worktree, "docs", "a", "x.md")))).toBeUndefined();
    expect(nativeRules(file("Edit", join(worktree, "lib", "c.ts")))).toBeUndefined();
  });

  test("project settings and settings.local.json are read for the checkout", () => {
    claudeSettings({ allow: ["Bash(make *)"] }, join(worktree, ".claude", "settings.json"));
    writeFileSync(
      join(worktree, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { deny: ["Bash(make deploy)"] } }),
    );
    clearNativeRuleCache();
    expect(nativeRules(bash("make test"))?.verdict).toBe("allow");
    expect(nativeRules(bash("make deploy"))?.verdict).toBe("deny");
    expect(nativeRules(bash("make test", "claude", root))).toBeUndefined();
  });

  test("MCP rules", () => {
    claudeSettings({ deny: ["mcp__github"], allow: ["mcp__docs__read_page"] });
    const mcp = (tool: string): Request => ({ ...bash("x"), tool, input: {} });
    expect(nativeRules(mcp("mcp__github__delete_repo"))?.verdict).toBe("deny");
    expect(nativeRules(mcp("mcp__docs__read_page"))?.verdict).toBe("allow");
    expect(nativeRules(mcp("mcp__docs__write_page"))).toBeUndefined();
  });

  test("an unreadable settings file is ignored", () => {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), "{ not json");
    clearNativeRuleCache();
    expect(nativeRules(bash("ls"))).toBeUndefined();
  });
});

describe("Codex execpolicy rules", () => {
  // https://developers.openai.com/codex/rules
  const rules = (text: string, path = join(codexHome, "rules", "default.rules")) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    clearNativeRuleCache();
  };
  const docExample = `
# A comment
prefix_rule(
    pattern = ["gh", "pr", "view"],
    decision = "prompt",
    justification = "Viewing PRs is allowed with approval",
    match = ["gh pr view 7888", "gh pr view --repo openai/codex"],
    not_match = ["gh pr --repo openai/codex view 7888"],
)
prefix_rule(pattern = ["git", ["status", "log", "diff"]])
prefix_rule(pattern = ["rm"], decision = "forbidden")
`;
  test("parses the documented form; decision defaults to allow; lists are alternatives", () => {
    const parsed = parseCodexRules(docExample);
    expect(parsed.map((rule) => [rule.pattern, rule.decision])).toEqual([
      [[["gh"], ["pr"], ["view"]], "prompt"],
      [[["git"], ["status", "log", "diff"]], "allow"],
      [[["rm"]], "forbidden"],
    ]);
  });

  test("a pattern must be an exact prefix", () => {
    rules(docExample);
    expect(nativeRules(bash("gh pr view 7888", "codex"))?.verdict).toBe("ask");
    expect(nativeRules(bash("gh pr --repo openai/codex view 7888", "codex"))).toBeUndefined();
    expect(nativeRules(bash("git log --oneline", "codex"))?.verdict).toBe("allow");
    expect(nativeRules(bash("git push", "codex"))).toBeUndefined();
    expect(nativeRules(bash("rm -rf x", "codex"))?.verdict).toBe("deny");
  });

  test("a linear chain is split and the strictest decision wins; anything else is one invocation", () => {
    rules(docExample);
    expect(codexInvocations("git status && git log")).toEqual([
      ["git", "status"],
      ["git", "log"],
    ]);
    expect(codexInvocations("git status > out")).toEqual([["bash", "-lc", "git status > out"]]);
    expect(nativeRules(bash("git status && git diff | git log", "codex"))?.verdict).toBe("allow");
    expect(nativeRules(bash("git status && rm x", "codex"))?.verdict).toBe("deny");
    expect(nativeRules(bash("git status && npm test", "codex"))).toBeUndefined();
    expect(nativeRules(bash("git status $(echo x)", "codex"))).toBeUndefined();
  });

  test("project rules apply only when config.toml trusts the project", () => {
    rules(
      'prefix_rule(pattern = ["make"], decision = "allow")',
      join(worktree, ".codex", "rules", "p.rules"),
    );
    expect(nativeRules(bash("make x", "codex"))).toBeUndefined();
    writeFileSync(
      join(codexHome, "config.toml"),
      `[projects."${worktree}"]\ntrust_level = "trusted"\n`,
    );
    clearNativeRuleCache();
    expect(nativeRules(bash("make x", "codex"))?.verdict).toBe("allow");
  });

  test("an unreadable rule is skipped, the rest still apply", () => {
    rules(
      'prefix_rule(pattern = [1, 2])\nprefix_rule(pattern = ["ls"])\nprefix_rule(pattern = "x"',
    );
    expect(nativeRules(bash("ls -la", "codex"))?.verdict).toBe("allow");
  });
});

test("Copilot has no documented persisted command allowlist, so nothing is matched", () => {
  expect(nativeRules(bash("ls", "copilot"))).toBeUndefined();
});

describe("the native rules layer in the session", () => {
  const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
  let n = 0;
  function session(harness: Request["harness"], classify?: () => ClassifierResult) {
    const directory = join(root, `s${n++}`);
    mkdirSync(directory, { mode: 0o700 });
    let runs = 0;
    const s = new PolicySession(directory, harness, "s1", permissive, undefined, {
      classify: async (cli) => {
        runs++;
        return (
          classify?.() ?? {
            ok: true,
            cli,
            model: "m",
            latencyMs: 1,
            verdict: { category: "unknown", confidence: 0.5, recoverable: false, rationale: "?" },
          }
        );
      },
    });
    return { s, directory, runs: () => runs };
  }

  test("Claude: an allow rule is the person's answer, checked before the classifier", async () => {
    claudeSettings({ allow: ["Bash(rm -rf /opt/*)"] });
    const { s, directory, runs } = session("claude");
    const d = await s.decide(bash("rm -rf /opt/frob"), "PreToolUse");
    expect(d).toMatchObject({ decision: "approve", userAllowRule: "Bash(rm -rf /opt/*)" });
    expect(runs()).toBe(0);
    const records = (await new AuditLog(directory).query({ limit: 100 })).records;
    expect(records.find((r) => r.eventName === "decision")?.attributes.userAllowRule).toBe(
      "Bash(rm -rf /opt/*)",
    );
  });

  test("a deny or ask rule beats any approval: no decision, so the harness applies it", async () => {
    claudeSettings({ ask: ["Bash(git status)"], deny: ["Bash(make *)"] });
    const { s, runs } = session("claude");
    const engineApproved = await s.decide(bash("git status"), "PreToolUse");
    expect(engineApproved).toMatchObject({ decision: "native", userRule: "Bash(git status)" });
    expect(hookResponse("claude", "PreToolUse", engineApproved)).toEqual({});
    expect((await s.decide(bash("make x"), "PreToolUse")).decision).toBe("native");
    expect(runs()).toBe(0);
  });

  test("an allow rule answers for a hard item, except a force push and an agent approving itself", async () => {
    claudeSettings({
      allow: [
        "Bash(git push *)",
        "Bash(git push --force *)",
        "Bash(git:*)",
        "Bash(policy-manager *)",
        "Bash(cat *)",
        "Bash(git clean *)",
      ],
    });
    const { s, runs } = session("claude");
    // Hard items an allow rule may answer for.
    expect((await s.decide(bash("cat ~/.aws/credentials"), "PreToolUse")).decision).toBe("approve");
    expect((await s.decide(bash("git clean -fd"), "PreToolUse")).decision).toBe("approve");
    // A force push, however it is written, is always asked; the harness prompts.
    for (const command of [
      "git push --force origin x",
      "git push -f origin x",
      "git push -uf origin x",
      "git push --force-with-lease origin x",
      "git push --force-if-includes origin x",
      "git push origin +x",
      "git push origin +refs/heads/x:refs/heads/x",
      "git push --mirror origin",
      "git push --for origin x",
    ]) {
      const d = await s.decide(bash(command), "PreToolUse");
      expect(d.decision, command).toBe("human");
      expect(JSON.stringify(hookResponse("claude", "PreToolUse", d)), command).toContain('"ask"');
    }
    expect((await s.decide(bash("git push origin x"), "PreToolUse")).decision).toBe("approve");
    expect((await s.decide(bash("policy-manager approve --last"), "PreToolUse")).decision).toBe(
      "human",
    );
    expect(runs()).toBe(0);
  });

  test("Codex: allow approves (PermissionRequest), prompt and forbidden leave it to Codex", async () => {
    writeFileSync(
      join(codexHome, "rules", "default.rules"),
      'prefix_rule(pattern = ["rm", "-rf"])\nprefix_rule(pattern = ["git", "status"], decision = "prompt")',
    );
    clearNativeRuleCache();
    const { s } = session("codex");
    const allowed = await s.decide(bash("rm -rf /opt/frob", "codex"), "PermissionRequest");
    expect(allowed).toMatchObject({ decision: "approve", userAllowRule: expect.any(String) });
    expect(JSON.stringify(hookResponse("codex", "PermissionRequest", allowed))).toContain("allow");
    const prompted = await s.decide(bash("git status", "codex"), "PreToolUse");
    expect(prompted.decision).toBe("native");
    expect(hookOutput("codex", "PreToolUse", prompted)).toBe("");
  });
});
