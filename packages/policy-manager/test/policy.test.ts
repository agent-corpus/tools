import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { executionReport, hookResponse, normalize } from "../src/adapters.js";
import { evaluate, hash, words } from "../src/policy.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

let root: string, repo: string, worktree: string, other: string;
function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function request(command: string): Request {
  return { sessionId: "test", harness: "codex", cwd: worktree, tool: "Bash", input: { command } };
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "policy-test-"));
  repo = join(root, "repo");
  worktree = join(root, "worktree");
  other = join(root, "other");
  mkdirSync(repo);
  mkdirSync(other);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "code.txt"), "code");
  git(repo, ["add", "code.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["worktree", "add", "-b", "feature", worktree]);
  git(other, ["init", "-b", "main"]);
  writeFileSync(join(other, "code.txt"), "other");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("approves writes only in a linked feature worktree", () => {
  const r = { ...request(""), tool: "Write", input: { file_path: "src/new.ts", content: "x" } };
  expect(evaluate(r).decision).toBe("approve");
  expect(evaluate({ ...r, cwd: repo }).decision).toBe("human");
  expect(evaluate({ ...r, cwd: other }).decision).toBe("human");
});
test("allows reads across repositories", () =>
  expect(
    evaluate({ ...request(""), tool: "Read", input: { file_path: join(other, "code.txt") } })
      .decision,
  ).toBe("approve"));
test.each([
  ".env",
  ".git/config",
  ".codex/hooks.json",
  ".agent-config/AGENTS.md",
  ".github/hooks/policy.json",
  "AGENTS.md",
])("protects %s", (path) =>
  expect(evaluate({ ...request(""), tool: "Write", input: { file_path: path } }).decision).toBe(
    "human",
  ),
);
test("resolves symlinks before approval", () => {
  symlinkSync(other, join(worktree, "outside"), process.platform === "win32" ? "junction" : "dir");
  expect(
    evaluate({ ...request(""), tool: "Write", input: { path: "outside/code.txt" } }).decision,
  ).toBe("human");
});
test.each([
  "cat code.txt; rm code.txt",
  "cat $(whoami)",
  "az resource list | bash",
  "cat ~/credentials",
  "cat *.txt",
  "cat <(curl x)",
  "cat code.txt\nrm code.txt",
])("rejects shell effects: %s", (command) => expect(words(command)).toBeUndefined());
test.each([
  "az resource list",
  "az resource show --ids '/subscriptions/example/resources/x'",
  "aws ec2 describe-instances --region us-east-1",
  "gcloud compute instances list --project example",
])("allows catalog inspection: %s", (command) =>
  expect(evaluate(request(command)).decision).toBe("approve"),
);
test.each([
  "az servicebus queue create --name q",
  "az resource delete --ids x",
  "az keyvault secret show --name x",
  "az resource list --debug",
  "aws ec2 describe-instances --endpoint-url https://evil.example",
  "gcloud projects delete example",
  "npm test",
  "python3 script.py",
  "git branch -D feature",
  "git push --force",
])("requires human: %s", (command) => expect(evaluate(request(command)).decision).toBe("human"));
test("branch evidence reports missing upstream and commits absent remotely", () =>
  expect(evaluate(request("git branch -D feature")).reason).toContain("upstream=absent"));
test("accepts structured patches and rejects protected and deletion targets", () => {
  const patch = (path: string) => ({
    ...request(""),
    tool: "apply_patch",
    input: { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` },
  });
  expect(evaluate(patch("src/new.ts")).decision).toBe("approve");
  expect(evaluate(patch(".codex/hooks.json")).decision).toBe("human");
  expect(
    evaluate({
      ...patch("x"),
      input: { command: "*** Begin Patch\n*** Delete File: code.txt\n*** End Patch" },
    }).category,
  ).toBe("destructive");
});
test("AI confidence cannot override unknown effects or hard rules", () => {
  const r = request("python3 unknown.py");
  expect(evaluate(r, { requestHash: hash(r), category: "code-read", confidence: 1 }).decision).toBe(
    "human",
  );
  const destructive = request("az resource delete --ids x");
  expect(
    evaluate(destructive, {
      requestHash: hash(destructive),
      category: "destructive",
      confidence: 1,
    }).decision,
  ).toBe("human");
  const read = request("az resource list");
  expect(
    evaluate(read, { requestHash: hash(read), category: "cloud-read", confidence: 0.5 }).decision,
  ).toBe("human");
  expect(
    evaluate(read, { requestHash: "wrong", category: "cloud-read", confidence: 1 }).decision,
  ).toBe("human");
});
test("cache is session scoped and audit excludes request values", () => {
  const directory = join(root, "audit");
  mkdirSync(directory, { mode: 0o700 });
  const session = new PolicySession(directory, "codex", "test");
  const r = request("az resource list --subscription private-subscription");
  expect(session.review(r).cached).toBe(false);
  expect(session.review(r).cached).toBe(true);
  const log = readFileSync(join(directory, "audit.jsonl"), "utf8");
  expect(log).not.toContain("private-subscription");
  expect(log).not.toContain(worktree);
  expect(log.trim().split("\n")).toHaveLength(4);
  expect(() => session.review({ ...r, sessionId: "other" })).toThrow("Session mismatch");
});
describe("harness normalization", () => {
  test("parses Copilot serialized toolArgs", () =>
    expect(
      normalize("copilot", {
        sessionId: "x",
        cwd: worktree,
        toolName: "bash",
        toolArgs: '{"command":"git status"}',
      }).input.command,
    ).toBe("git status"));
  test("honors actual execution directory", () =>
    expect(
      normalize("codex", {
        session_id: "x",
        cwd: repo,
        tool_name: "Bash",
        tool_input: { cmd: "git status", workdir: worktree },
      }).cwd,
    ).toBe(worktree));
  test("permission hooks preserve native human prompts", () => {
    const decision = evaluate(request("az resource delete --ids x"));
    for (const harness of ["claude", "codex", "copilot"] as const)
      expect(hookResponse(harness, "PermissionRequest", decision)).toEqual({});
  });
});

test("custom shell and environment cannot inherit a safe command decision", () => {
  expect(
    evaluate({ ...request("git status"), input: { command: "git status", shell: "/tmp/evil" } })
      .decision,
  ).toBe("human");
  expect(
    evaluate({
      ...request("git status"),
      input: { command: "git status", env: { LD_PRELOAD: "/tmp/evil" } },
    }).decision,
  ).toBe("human");
});

test("Git fetch is narrow and worktree creation constrains all targets", () => {
  git(repo, ["remote", "add", "origin", "https://github.com/example/repository.git"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  expect(evaluate({ ...request("git fetch origin"), cwd: repo }).decision).toBe("approve");
  expect(evaluate({ ...request("git fetch origin --prune"), cwd: repo }).decision).toBe("human");
  expect(
    evaluate({
      ...request("git worktree add --no-track .worktrees/new -b new-feature origin/main"),
      cwd: repo,
    }).decision,
  ).toBe("approve");
  expect(
    evaluate({
      ...request("git worktree add --no-track /tmp/outside -b new-feature origin/main"),
      cwd: repo,
    }).decision,
  ).toBe("human");
  expect(
    evaluate({
      ...request("git worktree add --no-track .worktrees/new -b main origin/main"),
      cwd: repo,
    }).decision,
  ).toBe("human");
});

test("quoting preserves literal query syntax without allowing shell expansion", () => {
  expect(
    evaluate(
      request(
        "az monitor log-analytics query --workspace example --analytics-query 'traces | take 1'",
      ),
    ).decision,
  ).toBe("approve");
  expect(evaluate(request('az resource list --query "[].name"')).decision).toBe("approve");
  expect(evaluate(request("cat [.]env")).decision).toBe("human");
  expect(evaluate(request("cat =sh")).decision).toBe("human");
  expect(words('cat "$(whoami)"')).toBeUndefined();
});

test("AI can approve a bounded cloud inspection and cache only that session request", () => {
  const directory = join(root, "ai-audit");
  mkdirSync(directory, { mode: 0o700 });
  const session = new PolicySession(directory, "codex", "test");
  const r = request("az network vnet list --resource-group example");
  expect(session.review(r).decision).toBe("human");
  expect(
    session.classify({ requestHash: hash(r), category: "cloud-read", confidence: 0.999 }).decision,
  ).toBe("approve");
  expect(session.review(r).cached).toBe(true);
  expect(session.review(request("az network vnet delete --name example")).decision).toBe("human");
  expect(
    session.review(request("az network vnet list --endpoint-url https://evil.example")).decision,
  ).toBe("human");
  const changed = request("az network vnet list --resource-group another");
  expect(session.review(changed).decision).toBe("human");
});

test("request, classification, decision and reported outcomes share audit correlation", async () => {
  const directory = join(root, "lifecycle-audit");
  mkdirSync(directory, { mode: 0o700 });
  const session = new PolicySession(directory, "codex", "test"),
    r = request("az network vnet list --resource-group hidden-target");
  session.review(r);
  session.classify({ requestHash: hash(r), category: "cloud-read", confidence: 0.999 });
  session.record({ event: "human-response", requestHash: hash(r), response: "approved" });
  session.record({
    event: "execution-result",
    requestHash: hash(r),
    status: "succeeded",
    exitCode: 0,
  });
  const { AuditLog } = await import("@agent-corpus/audit-log");
  const records = (await new AuditLog(directory).query({ requestId: hash(r) })).records;
  expect(new Set(records.map((r) => r.eventName))).toEqual(
    new Set(["request", "classification", "decision", "human-response", "execution-result"]),
  );
  const text = JSON.stringify(records);
  expect(text).not.toContain("hidden-target");
  expect(text).toContain("az network");
  expect(session.review(request("az resource delete --ids hidden-target")).decision).toBe("human");
});
test("audit failure prevents an automatic approval", () => {
  const directory = join(root, "blocked-audit");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "audit.lock"), "busy", { mode: 0o600 });
  const session = new PolicySession(directory, "codex", "test");
  expect(() => session.review(request("az resource list"))).toThrow();
});

test("post-tool reports preserve uncertainty and discard raw tool output", () => {
  const r = request("az resource list");
  expect(
    executionReport(r, "PostToolUse", { toolResult: { textResultForLlm: "private-output" } })
      .status,
  ).toBe("completed");
  const failed = executionReport(r, "PostToolUse", {
    tool_response: { exit_code: 1, stderr: "private-error" },
  });
  expect(failed.status).toBe("failed");
  expect(failed.exitCode).toBe(1);
  expect(JSON.stringify(failed)).not.toContain("private-error");
});

test.each([
  "az webapp config connection-string list --name example --resource-group example",
  "az webapp config appsettings list --name example --resource-group example",
  "az storage account keys list --resource-group example",
  "az webapp deployment list-publishing-credentials --name example --resource-group example",
  "az containerapp secret list --name example --resource-group example",
])("credential-returning reads never qualify for AI approval: %s", (command) => {
  const r = request(command);
  const decision = evaluate(r, { requestHash: hash(r), category: "cloud-read", confidence: 1 });
  expect(decision.decision).toBe("human");
  expect(decision.category).toBe("sensitive");
  expect(decision.cache).toBe("none");
  expect(decision.needsClassification).not.toBe(true);
});

test.each([
  "az webapp config container list --name example",
  "az webapp config storage-account list --name example",
  "gcloud container clusters describe example --project example",
])("unlisted cloud read routes cannot enter the AI approval path: %s", (command) => {
  const r = request(command);
  const decision = evaluate(r, { requestHash: hash(r), category: "cloud-read", confidence: 1 });
  expect(decision.decision).toBe("human");
  expect(decision.needsClassification).not.toBe(true);
});
