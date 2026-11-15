import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "@agent-corpus/audit-log";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hookOutput, hookResponse } from "../src/adapters.js";
import { ALWAYS_ASK_RULES, deferToNative } from "../src/native.js";
import { evaluate } from "../src/policy.js";
import { defaultProfilePath, ProfileError, parseProfile, strictProfile } from "../src/profile.js";
import { replayTranscripts } from "../src/replay.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
let root: string, repo: string, worktree: string, other: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "ignore",
  });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "native-test-")));
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
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function session(profile = permissive, harness: Request["harness"] = "claude") {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  return { directory, s: new PolicySession(directory, harness, "s1", profile) };
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
const PHASES = ["PreToolUse", "PermissionRequest"];

describe("decisions that need a person defer to the harness", () => {
  const deferred: Array<[string, () => Request]> = [
    [
      "a Claude memory file write",
      () => write(join(homedir(), ".claude", "projects", "p", "memory", "MEMORY.md")),
    ],
    ["a protected repository path write", () => write(join(worktree, ".agent-config", "a.md"))],
    ["an AGENTS.md write", () => write(join(worktree, "AGENTS.md"))],
    ["a credential read", () => shell("cat ~/.aws/credentials")],
    ["a cloud write", () => shell("az vm restart --name a --resource-group b")],
    ["a write on the main checkout", () => write(join(repo, "a.txt"), repo)],
    ["sudo", () => shell("sudo ls", repo)],
  ];
  test.each(deferred)("%s is native, with no hook decision in any harness", (_, make) => {
    const { s } = session();
    const r = make();
    const d = s.review(r, undefined, "PreToolUse");
    expect(d.decision).toBe("native");
    expect(d.deferred).toEqual(expect.any(String));
    expect(d.deferred).toBe(d.reason);
    expect(d.alwaysAsk).toBeUndefined();
    for (const harness of ["claude", "copilot", "codex"] as const)
      for (const phase of PHASES) {
        expect(hookResponse(harness, phase, d)).toEqual({});
        // Codex gets no output at all: its own sandbox and approval policy decide.
        if (harness === "codex") expect(hookOutput(harness, phase, d)).toBe("");
      }
    // Nothing waits for `approve --last`.
    expect(s.latestHumanDecision()).toBeUndefined();
  });

  test("the audit log records the deferral as native with the reason it would have asked", async () => {
    const { directory, s } = session();
    const r = write(join(worktree, "AGENTS.md"));
    const d = s.review(r, undefined, "PreToolUse");
    const records = (await new AuditLog(directory).query({ requestId: d.requestHash })).records;
    const decision = records.find((record) => record.eventName === "decision");
    expect(decision?.attributes).toMatchObject({
      decision: "native",
      deferred: "Protected path requires human approval",
    });
  });

  test("a memory file write defers in every phase, so a native session choice holds", () => {
    const { s } = session();
    const r = write(join(homedir(), ".claude", "projects", "p", "memory", "notes.md"));
    for (let i = 0; i < 3; i++)
      for (const phase of PHASES) {
        const d = s.review(r, undefined, phase);
        expect(hookResponse("claude", phase, d)).toEqual({});
      }
  });
});

describe("the default hard list still asks", () => {
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
      "~/.copilot/hooks",
      () => write(settings(".copilot", "hooks", "policy-manager.json")),
    ],
    [
      "harness-settings",
      "a shell redirect",
      () => shell("echo '{}' > ~/.claude/settings.json", repo),
    ],
    ["policy-profile", "the profile path", () => write(defaultProfilePath())],
  ];
  test.each(asks)("%s (%s)", (rule, _, make) => {
    const r = make();
    for (const harness of ["claude", "copilot", "codex"] as const) {
      const { s } = session(permissive, harness);
      let d = s.review({ ...r, harness }, undefined, "PreToolUse");
      // What the engine cannot decide is first sent to classification; unclassified, it falls back.
      if (d.classification === "requested")
        d = s.review({ ...r, harness }, undefined, "PreToolUse");
      expect(d).toMatchObject({ decision: "human", alwaysAsk: rule });
      const out = JSON.stringify(hookResponse(harness, "PreToolUse", d));
      if (harness === "codex") {
        expect(out).toContain('"permissionDecision":"deny"');
        expect(out).toContain("approve --last");
      } else expect(out).toContain('"ask"');
      // PermissionRequest fires only when the harness itself prompts: no decision there.
      expect(hookResponse(harness, "PermissionRequest", d)).toEqual({});
      expect(s.latestHumanDecision()?.requestHash).toBe(d.requestHash);
    }
  });

  test("the default list is exactly the documented rule ids", () => {
    expect(permissive.alwaysAsk).toEqual([...ALWAYS_ASK_RULES]);
    expect(strictProfile.alwaysAsk).toEqual([...ALWAYS_ASK_RULES]);
    expect(ALWAYS_ASK_RULES).toEqual([
      "force-push",
      "delete-unmerged-branch",
      "remove-worktree-force",
      "git-clean",
      "harness-settings",
      "policy-profile",
    ]);
  });

  test("approve --last and --session keep working for a hard-list item", () => {
    const { s } = session();
    const r = shell("git push --force origin feat/a");
    const d = s.review(r, undefined, "PreToolUse");
    expect(s.latestHumanDecision()?.requestHash).toBe(d.requestHash);
    expect(s.grant(d.requestHash, true).granted).toBe(true);
    for (const phase of PHASES) expect(s.review(r, undefined, phase).decision).toBe("approve");
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("human");
  });

  test("an agent running approve itself always asks, even with an empty list", () => {
    const { s } = session({ ...permissive, alwaysAsk: [] });
    const d = s.review(shell("policy-manager approve --last"), undefined, "PreToolUse");
    expect(d).toMatchObject({ decision: "human", alwaysAsk: "self-approve" });
  });

  test("hard blocks stay deny", () => {
    const d = {
      ...evaluate(shell("ls"), undefined, permissive),
      decision: "deny" as const,
    };
    expect(deferToNative(shell("ls"), d, [])).toBe(d);
  });
});

describe("profile alwaysAsk", () => {
  const profile = (alwaysAsk: unknown) =>
    parseProfile(JSON.stringify({ version: 1, mode: "permissive", alwaysAsk }));
  test("takes rule ids and categories", () => {
    expect(profile(["git-clean", "sensitive", "git-clean"]).alwaysAsk).toEqual([
      "git-clean",
      "sensitive",
    ]);
    expect(profile([]).alwaysAsk).toEqual([]);
  });
  test.each([["nope"], "force-push", [1], { a: 1 }, Array(51).fill("git-clean")])(
    "rejects %j",
    (value) => expect(() => profile(value)).toThrow(ProfileError),
  );
  test("an empty list defers even the default rules", () => {
    const { s } = session({ ...permissive, alwaysAsk: [] });
    expect(s.review(shell("git clean -fd"), undefined, "PreToolUse").decision).toBe("native");
  });
  test("a listed category asks", () => {
    const { s } = session({ ...permissive, alwaysAsk: ["sensitive"] });
    const d = s.review(write(join(worktree, "AGENTS.md")), undefined, "PreToolUse");
    expect(d).toMatchObject({ decision: "human", alwaysAsk: "sensitive" });
  });
});

describe("classification block is opt-in", () => {
  test("off by default: an ambiguous request defers with no block and no request to classify", async () => {
    expect(permissive.classify).toBe(false);
    const { directory, s } = session();
    const r = shell("echo $UNSET_VALUE");
    const d = s.review(r, undefined, "PreToolUse");
    expect(d).toMatchObject({ decision: "native", tier: "ambiguous" });
    expect(d.classification).toBeUndefined();
    expect(hookResponse("claude", "PreToolUse", d)).toEqual({});
    expect(hookOutput("codex", "PreToolUse", d)).toBe("");
    const records = (await new AuditLog(directory).query({ limit: 1000 })).records;
    expect(records.some((record) => record.eventName === "classification-requested")).toBe(false);
  });

  test("off, a recorded classification still approves the retry", () => {
    const { s } = session();
    const r = shell("echo $RECORDED_VALUE");
    const first = s.review(r, undefined, "PreToolUse");
    expect(first.decision).toBe("native");
    const classified = s.classify({
      requestHash: first.requestHash,
      category: "code-read",
      confidence: 0.99,
      recoverable: true,
    });
    expect(classified.decision).toBe("approve");
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("approve");
  });

  test("off, an unparsed hard-list command asks at once; Codex gets the approve command", () => {
    const r = shell("git push -f origin {feat/a,x}");
    const { s } = session();
    expect(s.review(r, undefined, "PreToolUse")).toMatchObject({
      decision: "human",
      alwaysAsk: "force-push",
    });
    const codex = session(permissive, "codex").s;
    const d = codex.review({ ...r, harness: "codex" }, undefined, "PreToolUse");
    const text = JSON.stringify(hookResponse("codex", "PreToolUse", d));
    expect(text).toContain("approve --last");
    expect(text).not.toContain("Classify it");
  });

  test("on: the first PreToolUse is a classification block", () => {
    const { s } = session({ ...permissive, classify: true });
    const d = s.review(shell("echo $BLOCKED_VALUE"), undefined, "PreToolUse");
    expect(d).toMatchObject({ decision: "deny", classification: "requested" });
  });

  test.each([["yes"], [1], [null]])("classify %j is invalid", (value) =>
    expect(() =>
      parseProfile(JSON.stringify({ version: 1, mode: "permissive", classify: value })),
    ).toThrow(ProfileError),
  );
});

describe("replay", () => {
  test("splits escalations into native deferrals and hard-list asks", () => {
    const file = join(root, "transcript.jsonl");
    const line = (command: string) =>
      JSON.stringify({
        cwd: worktree,
        message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
      });
    writeFileSync(
      file,
      [
        line("git push --force origin feat/a"),
        line("git clean -fd"),
        line("cat ~/.aws/credentials"),
        line("echo $ONE"),
        line("git status"),
      ].join("\n"),
    );
    const report = replayTranscripts([file], permissive);
    expect(report).toMatchObject({
      commands: 5,
      approved: 1,
      deferred: 2,
      classificationBlocks: 0,
      stillAsk: 2,
    });
    expect(report.askReasons.map((row) => row.rule).sort()).toEqual(["force-push", "git-clean"]);
    // With classify on, the ambiguous `echo $ONE` is a classification block instead.
    expect(replayTranscripts([file], { ...permissive, classify: true })).toMatchObject({
      approved: 1,
      deferred: 1,
      classificationBlocks: 1,
      stillAsk: 2,
    });
  });
});
