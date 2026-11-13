import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuditLog } from "@agent-corpus/audit-log";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hookResponse } from "../src/adapters.js";
import { hookConfig } from "../src/config.js";
import { evaluate, hash } from "../src/policy.js";
import { MAX_MCP_READ_ONLY, ProfileError, parseProfile, strictProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import { setupHook } from "../src/setup.js";
import type { Request } from "../src/types.js";

const profile = (mcpReadOnly: unknown, mode = "permissive") =>
  parseProfile(JSON.stringify({ version: 1, mode, mcpReadOnly }));
const listed = profile(["mcp__ado__wit_get_work_item", "mcp__github__get_*"]);
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-test-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const request = (tool: string, input: Record<string, unknown> = {}): Request => ({
  sessionId: "s1",
  harness: "claude",
  cwd: root,
  tool,
  input,
});

describe("mcpReadOnly validation", () => {
  test("accepts exact names and tool-segment prefixes", () => {
    expect(listed.mcpReadOnly).toEqual(["mcp__ado__wit_get_work_item", "mcp__github__get_*"]);
    expect(parseProfile(JSON.stringify({ version: 1, mode: "strict" })).mcpReadOnly).toEqual([]);
  });
  test.each([
    ["not a list", "mcp__a__b"],
    ["a server wildcard", ["mcp__*"]],
    ["a bare tool wildcard", ["mcp__github__*"]],
    ["a wildcard inside the name", ["mcp__github__get_*_x"]],
    ["a regular expression", ["^mcp__github__.*$"]],
    ["a non-MCP tool", ["Bash"]],
    ["a missing tool segment", ["mcp__github"]],
    ["an ambiguous server/tool split", ["mcp__a__b__c"]],
    ["a tool segment starting with _", ["mcp__a___b"]],
    ["a server segment ending with _", ["mcp__a___b*"]],
    ["a non-string", [1]],
    ["an overlong name", [`mcp__a__${"x".repeat(130)}`]],
    ["too many names", Array.from({ length: MAX_MCP_READ_ONLY + 1 }, (_, i) => `mcp__a__t${i}`)],
  ])("rejects %s", (_, value) => {
    expect(() => profile(value)).toThrow(ProfileError);
  });
});

describe("MCP decisions", () => {
  test.each([
    ["mcp__ado__wit_get_work_item", "approve"],
    ["mcp__github__get_issue", "approve"],
    ["mcp__ado__wit_get_work_item_x", "native"],
    ["mcp__ado__wit_update_work_item", "native"],
    ["mcp__github__create_issue", "native"],
    ["mcp__github__get", "native"],
    // A wildcard never reaches past the tool segment into another server's name.
    ["mcp__github__get__evil__tool", "native"],
    // Server `github__get`, tool `x`: the `__` straddles the wildcard's prefix.
    ["mcp__github__get__x", "native"],
    ["mcp__github_get_issue", "native"],
  ])("%s -> %s", (tool, expected) => {
    expect(evaluate(request(tool), undefined, listed).decision).toBe(expected);
  });
  test("a listed tool approves in strict mode; nothing is listed without a profile", () => {
    const strict = profile(["mcp__ado__wit_get_work_item"], "strict");
    expect(evaluate(request("mcp__ado__wit_get_work_item"), undefined, strict).decision).toBe(
      "approve",
    );
    expect(
      evaluate(request("mcp__ado__wit_get_work_item"), undefined, strictProfile).decision,
    ).toBe("native");
  });
  test("tool arguments named cwd or path do not change the decision", () => {
    const r = request("mcp__github__get_file", { cwd: "/elsewhere", path: "/etc/passwd" });
    expect(evaluate(r, undefined, listed).decision).toBe("approve");
  });
  test.each(["claude", "codex", "copilot"] as const)(
    "%s: an unlisted tool returns no decision in either phase",
    (harness) => {
      const d = evaluate({ ...request("mcp__x__delete"), harness }, undefined, listed);
      expect(hookResponse(harness, "PreToolUse", d)).toEqual({});
      expect(hookResponse(harness, "PermissionRequest", d)).toEqual({});
    },
  );
  test("an unlisted tool is never sent to classification or a human", () => {
    const directory = join(root, "s-native");
    mkdirSync(directory, { mode: 0o700 });
    const s = new PolicySession(directory, "claude", "s1", listed);
    const first = s.review(request("mcp__x__delete"), undefined, "PreToolUse");
    const again = s.review(request("mcp__x__delete"), undefined, "PreToolUse");
    expect([first.decision, again.decision]).toEqual(["native", "native"]);
    expect(first.classification).toBeUndefined();
  });
  test("the audit log hashes the tool name and records no argument values", async () => {
    const directory = join(root, "s-audit");
    mkdirSync(directory, { mode: 0o700 });
    const s = new PolicySession(directory, "claude", "s1", listed);
    const r = request("mcp__github__get_issue", {
      command: "git status",
      path: "/secret/value",
      owner: "private-owner",
    });
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("approve");
    const text = JSON.stringify((await new AuditLog(directory).query({ limit: 100 })).records);
    expect(text).toContain(hash("mcp__github__get_issue"));
    for (const secret of ["mcp__github__get_issue", "private-owner", "/secret/value", "git status"])
      expect(text).not.toContain(secret);
  });
});

describe("MCP hook setup", () => {
  const matchers = (harness: "claude" | "codex" | "copilot") => {
    const config = hookConfig(harness, "/opt/pm/dist/cli.js") as {
      hooks: Record<string, { matcher?: string }[]>;
    };
    const pre = harness === "copilot" ? "preToolUse" : "PreToolUse";
    const post = harness === "copilot" ? "postToolUse" : "PostToolUse";
    return { pre: config.hooks[pre]?.[0]?.matcher, post: config.hooks[post]?.[0]?.matcher };
  };
  test.each(["claude", "codex"] as const)("%s PreToolUse covers MCP tools", (harness) => {
    const { pre, post } = matchers(harness);
    expect(new RegExp(`^(?:${pre})$`).test("mcp__github__get_issue")).toBe(true);
    expect(pre).toContain("Bash");
    expect(post).not.toContain("mcp__");
  });
  test("copilot has no MCP matcher (no documented MCP tool name)", () => {
    expect(matchers("copilot").pre).not.toContain("mcp__");
  });
  test.each(["claude", "codex"] as const)(
    "%s setup adds the MCP matcher to an older install idempotently, keeping custom hooks",
    (harness) => {
      const base = mkdtempSync(join(root, `setup-${harness}-`));
      const installed = join(base, "installed", "dist", "cli.js");
      mkdirSync(dirname(installed), { recursive: true });
      writeFileSync(installed, "// fixture\n");
      const configDirectory = join(base, "config");
      const file = join(configDirectory, harness === "claude" ? "settings.json" : "hooks.json");
      const older = hookConfig(harness, installed) as {
        hooks: Record<string, { matcher?: string }[]>;
      };
      const group = older.hooks.PreToolUse?.[0];
      if (group) group.matcher = group.matcher?.replace("|mcp__.*", "");
      const custom = { matcher: "mcp__.*", hooks: [{ type: "command", command: "custom-mcp" }] };
      older.hooks.PreToolUse?.unshift(custom);
      mkdirSync(configDirectory);
      writeFileSync(file, JSON.stringify(older));
      const preview = setupHook(harness, installed, { configDirectory, dryRun: true });
      expect(preview.changed).toBe(true);
      expect(JSON.stringify(preview.managedHooks)).toContain("mcp__.*");
      expect(setupHook(harness, installed, { configDirectory }).changed).toBe(true);
      const after = readFileSync(file, "utf8");
      const pre = JSON.parse(after).hooks.PreToolUse as { matcher: string }[];
      expect(pre).toHaveLength(2);
      expect(pre[0]).toEqual(custom);
      expect(pre[1]?.matcher).toMatch(/\|mcp__\.\*$/);
      expect(setupHook(harness, installed, { configDirectory }).changed).toBe(false);
      expect(setupHook(harness, installed, { configDirectory, dryRun: true }).changed).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(after);
    },
  );
});
