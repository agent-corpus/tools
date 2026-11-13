import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "@agent-corpus/audit-log";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { classifyCommand, hookResponse } from "../src/adapters.js";
import { audit, requestSummary } from "../src/audit.js";
import { evaluate, hash, requestHash } from "../src/policy.js";
import { HUMAN_REVIEW_PRINCIPLE } from "../src/principle.js";
import { parseProfile } from "../src/profile.js";
import { redactText } from "../src/redact.js";
import { replayTranscripts } from "../src/replay.js";
import { formatReview, reviewClassifications } from "../src/review.js";
import { MAX_AI_APPROVALS, PolicySession } from "../src/session.js";
import type { Classification, Request } from "../src/types.js";

const permissive = parseProfile(
  JSON.stringify({ version: 1, mode: "permissive", humanPatterns: ["^terraform apply"] }),
);
let root: string, work: string;
let counter = 0;
const request = (command: string): Request => ({
  sessionId: "s1",
  harness: "claude",
  cwd: work,
  tool: "Bash",
  input: { command },
});
// `$VAR` is an expansion the parser cannot resolve, so the engine cannot decide it: ambiguous.
const ambiguous = (name = `V${counter++}`) => request(`echo $${name}`);
function session(profile = permissive) {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  return { directory, session: new PolicySession(directory, "claude", "s1", profile) };
}
const verdict = (r: Request, extra: Partial<Classification> = {}): Classification => ({
  requestHash: hash(r),
  category: "code-read",
  confidence: 0.97,
  recoverable: true,
  rationale: "Only prints a variable.",
  ...extra,
});
async function events(directory: string, name?: string) {
  const all = (await new AuditLog(directory).query({ limit: 10000 })).records;
  return name ? all.filter((r) => r.eventName === name) : all;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "classification-test-"));
  // A repository, so deletions under `work` are not disposable temp-directory deletions.
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  work = join(root, "work");
  mkdirSync(work);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("hint and retry flow", () => {
  test("the first hook call blocks with an instruction, never a human prompt", async () => {
    const { directory, session: s } = session();
    const r = ambiguous();
    const d = s.review(r, undefined, "PreToolUse");
    expect(d.decision).toBe("deny");
    expect(d.classification).toBe("requested");
    const out = JSON.stringify(
      hookResponse("claude", "PreToolUse", d, { cliPath: "/opt/cli.js", sessionId: "s1" }),
    );
    expect(out).toContain('"permissionDecision":"deny"');
    expect(out).toContain('"permissionDecisionReason":"Needs classification (not an error)');
    expect(out).toContain("|temp-write|");
    expect(out).toContain(hash(r));
    expect(out).toContain("/opt/cli.js");
    expect(out).toContain("classify claude s1");
    expect(out).not.toContain('"ask"');
    expect(await events(directory, "classification-requested")).toHaveLength(1);
  });

  test("a confident recoverable classification approves, and the retry runs", () => {
    const { session: s } = session();
    const r = ambiguous();
    s.review(r, undefined, "PreToolUse");
    expect(s.classify(verdict(r)).decision).toBe("approve");
    const retry = s.review(r, undefined, "PreToolUse");
    expect(retry.decision).toBe("approve");
    expect(hookResponse("claude", "PreToolUse", retry)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  });

  test("a not-recoverable or low-confidence classification denies with a reason, every time", () => {
    for (const extra of [{ recoverable: false }, { confidence: 0.6 }, { recoverable: undefined }]) {
      const { session: s } = session();
      const r = ambiguous();
      s.review(r, undefined, "PreToolUse");
      const first = s.classify(verdict(r, extra));
      expect(first.decision).toBe("deny");
      expect(first.reason).toContain("Not run");
      for (let i = 0; i < 3; i++) {
        const again = s.review(r, undefined, "PreToolUse");
        expect(again.decision).toBe("deny");
        expect(again.classification).toBe("denied");
      }
      const response = hookResponse("claude", "PreToolUse", first);
      expect(JSON.stringify(response)).toContain('"permissionDecision":"deny"');
    }
  });

  test("an unusable classifier falls back to a human exactly once, and the reason is recorded", async () => {
    const { directory, session: s } = session();
    const r = ambiguous();
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("deny");
    const second = s.review(r, undefined, "PreToolUse");
    expect(second.decision).toBe("human");
    expect(second.fallbackReason).toBe("unavailable");
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("human");
    expect(s.review(r, undefined, "PermissionRequest").decision).toBe("human");
    const fallbacks = await events(directory, "classification-fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.attributes.fallbackReason).toBe("unavailable");
  });

  test("an invalid classification falls back to a human on the retry", async () => {
    const { directory, session: s } = session();
    const r = ambiguous();
    s.review(r, undefined, "PreToolUse");
    expect(() => s.classify(verdict(r, { confidence: Number.NaN }))).toThrow();
    expect(() => s.classify(verdict(r, { category: "bogus" as never }))).toThrow();
    const retry = s.review(r, undefined, "PreToolUse");
    expect(retry.decision).toBe("human");
    expect(retry.fallbackReason).toBe("invalid-result");
    expect((await events(directory, "classification-fallback"))[0]?.attributes.fallbackReason).toBe(
      "invalid-result",
    );
  });

  test("a classification for another request is rejected and approves nothing", () => {
    const { session: s } = session();
    const r = ambiguous();
    const other = ambiguous();
    s.review(r, undefined, "PreToolUse");
    expect(() => s.classify(verdict(other))).toThrow();
    expect(evaluate(r, verdict(other), permissive).decision).toBe("human");
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("human");
  });

  test("a session cap on AI approvals sends the rest to a human", () => {
    const { session: s } = session();
    let last = s.review(ambiguous(), undefined);
    let limited = ambiguous();
    for (let i = 0; i <= MAX_AI_APPROVALS; i++) {
      const r = ambiguous();
      limited = r;
      s.review(r, undefined, "PreToolUse");
      last = s.classify(verdict(r));
    }
    expect(last.decision).toBe("human");
    expect(last.fallbackReason).toBe("limit");
    // The limit is part of the remembered outcome: the retry must not run without a person.
    const retried = s.review(limited, undefined, "PreToolUse");
    expect(retried.decision).toBe("human");
    expect(retried.fallbackReason).toBe("limit");
  });

  test("a verdict is final: a deny cannot be reclassified, and an approval cannot be replaced", () => {
    const { session: s } = session();
    const denied = ambiguous();
    s.review(denied, undefined, "PreToolUse");
    expect(s.classify(verdict(denied, { recoverable: false })).decision).toBe("deny");
    expect(() => s.classify(verdict(denied, { confidence: 0.99 }))).toThrow();
    expect(s.review(denied, undefined, "PreToolUse").decision).toBe("deny");
    const approved = ambiguous();
    s.review(approved, undefined, "PreToolUse");
    s.classify(verdict(approved));
    expect(() => s.classify(verdict(approved, { recoverable: false }))).toThrow();
    expect(s.review(approved, undefined, "PreToolUse").decision).toBe("approve");
  });

  test("calls outside a hook, and strict mode, behave as before", () => {
    const { session: s } = session();
    expect(s.review(ambiguous()).decision).toBe("human");
    const strict = session(parseProfile(JSON.stringify({ version: 1, mode: "strict" })));
    const r = ambiguous();
    const d = strict.session.review(r, undefined, "PreToolUse");
    expect(d.decision).toBe("human");
    expect(d.classification).toBeUndefined();
    expect(hookResponse("claude", "PreToolUse", d)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
  });
});

describe("the AI never relaxes a deterministic boundary", () => {
  const always: Array<[string, string]> = [
    ["credential path", "cat /home/user/.aws/credentials"],
    ["protected path", "echo x > .claude/settings.json"],
    ["organization pattern", "terraform apply"],
    ["environment override", "LD_PRELOAD=/tmp/x.so ls"],
    ["cloud write", "az vm restart --name a --resource-group b"],
  ];
  for (const [name, command] of always)
    test(`${name} stays with a human even with a perfect classification`, () => {
      const { session: s } = session();
      const r = request(command);
      const d = s.review(r, undefined, "PreToolUse");
      expect(d.decision).toBe("human");
      expect(d.tier).toBeUndefined();
      const outcome = (() => {
        try {
          return s.classify(verdict(r, { confidence: 1 })).decision;
        } catch {
          return "rejected";
        }
      })();
      expect(["human", "rejected"]).toContain(outcome);
      expect(evaluate(r, verdict(r, { confidence: 1 }), permissive).decision).toBe("human");
    });

  test("sensitive and unknown categories from the AI are denied", () => {
    for (const category of ["sensitive", "unknown"] as const) {
      const { session: s } = session();
      const r = ambiguous();
      s.review(r, undefined, "PreToolUse");
      expect(s.classify(verdict(r, { category, confidence: 1 })).decision).toBe("deny");
    }
  });
});

describe("destructive requests follow recoverability", () => {
  test("the classification hint carries the shared principle", () => {
    const { session: s } = session();
    const first = s.review(ambiguous(), undefined, "PreToolUse");
    expect(first).toMatchObject({ decision: "deny", classification: "requested" });
    expect(JSON.stringify(hookResponse("claude", "PreToolUse", first))).toContain(
      HUMAN_REVIEW_PRINCIPLE,
    );
  });

  // Deletion inside a linked feature worktree is classified; see recoverable.test.ts.
  test.each([
    "rm -rf build", // not in a linked feature worktree
    "git push --force origin feature",
    "git push origin +feature",
    "git push origin --delete wip",
    "git branch -D wip",
    "git reflog expire --all",
    "git stash drop",
    "git clean -fdx",
    "az group delete --name x",
    "terraform destroy",
    "npm publish",
    "gh repo delete o/r",
    "rm -rf ~/Documents",
    "curl -X DELETE https://example.com/x",
    "sudo ls",
  ])("%s stays with a person even on a confident recoverable verdict", (command) => {
    const r = request(command);
    const d = evaluate(r, undefined, permissive);
    expect(d.decision).toBe("human");
    expect(d.tier).toBeUndefined();
    const verdictFor = verdict(r, { category: "destructive", confidence: 0.99, recoverable: true });
    expect(evaluate(r, verdictFor, permissive).decision).toBe("human");
  });

  test("a destructive label approves nothing the engine did not prove is a worktree deletion", () => {
    for (const command of [
      "rm -rf ~/{Documents,x}",
      "git push --force origin {feature,x}",
      "git clean -fdx {a,b}",
      "echo $SOME_VAR",
    ]) {
      const { session: s } = session();
      const r = request(command);
      expect(s.review(r, undefined, "PreToolUse").classification, command).toBe("requested");
      const d = s.classify(verdict(r, { category: "destructive", confidence: 0.99 }));
      expect(d.decision, command).toBe("human");
    }
    // A non-destructive label on an ambiguous request still follows the verdict, as on main.
    const { session: s } = session();
    const r = request("echo $SOME_VAR");
    s.review(r, undefined, "PreToolUse");
    expect(s.classify(verdict(r, { category: "code-read", confidence: 0.99 })).decision).toBe(
      "approve",
    );
  });

  test("an ambiguous request the AI calls destructive but unrecoverable goes to a person", () => {
    const { session: s } = session();
    const r = ambiguous();
    s.review(r, undefined, "PreToolUse");
    expect(s.classify(verdict(r, { category: "destructive", recoverable: false })).decision).toBe(
      "human",
    );
  });

  test("sensitive is never relaxed, even when the classifier says recoverable", () => {
    for (const command of ["cat /home/user/.aws/credentials", "echo x > .claude/settings.json"]) {
      const r = request(command);
      for (const category of ["code-read", "worktree-write", "destructive"] as const)
        expect(
          evaluate(r, verdict(r, { category, confidence: 1, recoverable: true }), permissive)
            .decision,
        ).toBe("human");
    }
  });
});

describe("recording", () => {
  test("secrets never reach the audit log, in the command or the rationale", async () => {
    const { directory, session: s } = session();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const bearer = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MHF3ZXJ0eXVpb3A";
    const r = request(
      `curl -H "Authorization: Bearer ${bearer}" --password hunter2 https://user:pw@api.example/x?token=abc $HOME_X`,
    );
    s.review(r, undefined, "PreToolUse");
    s.classify(
      verdict(r, { category: "unknown", rationale: `Uses ${secret} and password=hunter2` }),
    );
    const text = JSON.stringify(await events(directory));
    for (const leaked of [secret, bearer, "hunter2", "pw@", "token=abc"])
      expect(text).not.toContain(leaked);
    expect(text).toContain("curl");
  });

  test("redactText keeps commands readable and hides values that look like secrets", () => {
    expect(redactText("git push origin main")).toBe("git push origin main");
    expect(redactText("tool --api-key abc123 run")).toBe("tool --api-key [REDACTED] run");
    expect(redactText("DB_PASSWORD=x run")).toBe("DB_PASSWORD=[REDACTED] run");
    expect(redactText(`echo ${"a".repeat(40)}`)).toBe("echo [REDACTED]");
    expect(redactText('curl -H "X-Api-Key: abc123" x')).toBe('curl -H "X-Api-Key: [REDACTED]" x');
    expect(redactText('curl -H "Authorization: Bearer abc123" x')).toBe(
      'curl -H "Authorization: [REDACTED]" x',
    );
    expect(redactText("curl -H Authorization: Bearer abc123 x")).toBe(
      "curl -H Authorization: Bearer [REDACTED] x",
    );
    expect(redactText("mysql -pS3cretPass db")).toBe("mysql -p[REDACTED] db");
    expect(redactText("cd x && mysql -pabc db")).toBe("cd x && mysql -p[REDACTED] db");
    expect(redactText("find . -path ./x -print -perm 644")).toBe(
      "find . -path ./x -print -perm 644",
    );
    expect(redactText('echo "ghp_abcdefghijklmnopqrstuvwxyz0123456789"')).toBe("echo [REDACTED]");
    expect(redactText(`echo '${"a1".repeat(20)}' ok`)).toBe("echo [REDACTED] ok");
    expect(redactText("curl -u user:pass https://h/x")).toBe("curl -u [REDACTED] https://h/x");
    expect(redactText('tool --password "two words" run')).toBe("tool --password [REDACTED] run");
    expect(redactText('tool --password="two words" run')).toBe("tool --password=[REDACTED] run");
    expect(redactText("git commit --author=x --message hi")).toBe(
      "git commit --author=x --message hi",
    );
    expect(redactText("tool --auth-token=abc --auth=def")).toBe(
      "tool --auth-token=[REDACTED] --auth=[REDACTED]",
    );
    expect(redactText("curl https://u:p@host.example/a/b?token=1#f")).toBe(
      "curl https://[REDACTED]@host.example/a/b?[REDACTED]",
    );
    const hostile = `a://${'@"'.repeat(20000)}`;
    const started = Date.now();
    redactText(hostile, 100);
    expect(Date.now() - started).toBeLessThan(500);
    expect(redactText("ab ".repeat(100), 50)).toHaveLength(51);
  });

  test("review-classifications reports outcomes, histogram, failures and human denials", async () => {
    const a = session();
    const approved = ambiguous("APPROVED");
    a.session.review(approved, undefined, "PreToolUse");
    a.session.classify(verdict(approved, { confidence: 0.97 }));
    a.session.record({
      event: "execution-result",
      requestHash: hash(approved),
      status: "failed",
      exitCode: 2,
    });
    const denied = ambiguous("DENIED");
    a.session.review(denied, undefined, "PreToolUse");
    a.session.classify(verdict(denied, { recoverable: false, confidence: 0.8 }));
    const fallback = ambiguous("FALLBACK");
    a.session.review(fallback, undefined, "PreToolUse");
    a.session.review(fallback, undefined, "PreToolUse");
    a.session.record({ event: "human-response", requestHash: hash(fallback), response: "denied" });
    const abandoned = ambiguous("ABANDONED");
    a.session.review(abandoned, undefined, "PreToolUse");

    const review = await reviewClassifications([a.directory, join(root, "missing")]);
    expect(review).toMatchObject({
      sessions: 1,
      requested: 4,
      approved: 1,
      denied: 1,
      fallback: 1,
      unresolved: 1,
      fallbackReasons: { unavailable: 1 },
    });
    expect(review.fallbackRate).toBeCloseTo(0.25);
    expect(review.approvedButFailed).toHaveLength(1);
    expect(review.humanDenied).toHaveLength(1);
    expect(review.histogram.find((b) => b.range === "0.95-0.99")?.count).toBe(1);
    expect(review.aiApproved[0]?.command).toBe("echo $APPROVED");
    const text = formatReview(review);
    expect(text).toContain("AI approved:        1");
    expect(text).toContain("echo $APPROVED");
  });
});

describe("the classify round trip", () => {
  const installed = join(
    homedir(),
    ".local/share/agent-corpus/policy-manager/0.5.0/lib/node_modules/@agent-corpus/policy-manager/dist/cli.js",
  );
  const answer =
    '{"requestHash":"abc","category":"code-read","confidence":0.97,"recoverable":true,"rationale":"prints a variable"}';
  for (const harness of ["claude", "codex", "copilot"] as const)
    for (const cliPath of ["/opt/cli.js", installed]) {
      test(`the instructed command is approved by the policy itself (${harness}, ${cliPath.slice(-24)})`, () => {
        const command = classifyCommand(harness, { cliPath, sessionId: "s1" }, answer);
        expect(command).toContain("classify");
        const d = evaluate({ ...request(command), harness }, undefined, permissive);
        expect(d.decision).toBe("approve");
        expect(d.tier).toBeUndefined();
      });
    }
  // Simulated Windows paths run on every platform, so the round trip is proven on Windows
  // without depending on the runner's own home directory.
  for (const cliPath of [
    "D:\\a\\tools\\tools\\packages\\policy-manager\\dist\\cli.js",
    "C:\\Users\\me\\.local\\share\\agent-corpus\\policy-manager\\0.5.0\\lib\\node_modules\\@agent-corpus\\policy-manager\\dist\\cli.js",
  ])
    test(`a Windows-style path still yields a command the policy approves (${cliPath.slice(0, 12)})`, () => {
      const command = classifyCommand("claude", { cliPath, sessionId: "s1" }, answer);
      expect(command).not.toContain("\\");
      expect(command).toContain("classify claude s1");
      expect(evaluate(request(command), undefined, permissive).decision).toBe("approve");
    });
  test("the hook's instruction contains exactly that command", () => {
    const { session: s } = session();
    const d = s.review(ambiguous(), undefined, "PreToolUse");
    const out = JSON.stringify(
      hookResponse("claude", "PreToolUse", d, { cliPath: installed, sessionId: "s1" }),
    );
    const command = classifyCommand("claude", { cliPath: installed, sessionId: "s1" });
    expect(out).toContain(JSON.stringify(command).slice(1, -1));
  });
  test("a path or session id that cannot be quoted safely falls back to a generic command", () => {
    expect(classifyCommand("claude", { cliPath: '/x"y/cli.js', sessionId: "s1" })).toContain(
      "policy-manager classify",
    );
    expect(classifyCommand("claude", { cliPath: "/ok/cli.js", sessionId: "a b;rm" })).toContain(
      "<session-id>",
    );
  });
});

describe("the session approves only its own record command", () => {
  const cliPath = "/opt/pm/dist/cli.js";
  const recording = (
    harness: Request["harness"] = "claude",
    profile = permissive,
    path: string = cliPath,
  ) => {
    const directory = join(root, `r${counter++}`);
    mkdirSync(directory, { mode: 0o700 });
    return new PolicySession(directory, harness, "s1", profile, path);
  };
  const shell = (command: string, harness: Request["harness"] = "claude"): Request => ({
    ...request(command),
    harness,
    tool: harness === "codex" ? "exec_command" : harness === "copilot" ? "bash" : "Bash",
  });
  const answer = (r: Request) => JSON.stringify(verdict(r));
  const own = (json = '{"requestHash":"abc"}', harness: Request["harness"] = "claude") =>
    classifyCommand(harness, { cliPath, sessionId: "s1" }, json);

  for (const harness of ["claude", "codex", "copilot"] as const)
    for (const profile of [permissive, parseProfile('{"version":1,"mode":"strict"}')])
      test(`approved deterministically (${harness}, ${profile.mode})`, () => {
        const d = recording(harness, profile).review(
          shell(own(undefined, harness), harness),
          undefined,
          "PreToolUse",
        );
        expect(d.decision).toBe("approve");
        expect(d.classification).toBeUndefined();
      });

  test("a Windows CLI path is matched in the form the hook writes", () => {
    const windows = "D:\\a\\pm\\dist\\cli.js";
    const command = classifyCommand("claude", { cliPath: windows, sessionId: "s1" }, "{}");
    const s = recording("claude", permissive, windows);
    expect(s.review(request(command), undefined, "PreToolUse").decision).toBe("approve");
  });

  test.each([
    ["another session", classifyCommand("claude", { cliPath, sessionId: "s2" }, "{}")],
    ["another harness", classifyCommand("codex", { cliPath, sessionId: "s1" }, "{}")],
    [
      "another CLI path",
      classifyCommand("claude", { cliPath: "/tmp/evil/cli.js", sessionId: "s1" }, "{}"),
    ],
    [
      "another installed version",
      classifyCommand("claude", { cliPath: "/opt/pm-0.4.0/dist/cli.js", sessionId: "s1" }, "{}"),
    ],
    ["the generic form", "policy-manager classify claude s1 <<< '{}'"],
    ["an unquoted path", `node ${cliPath} classify claude s1 <<< '{}'`],
    ["a double-quoted answer", `node "${cliPath}" classify claude s1 <<< "{}"`],
    ["a pipe in", `echo '{}' | node "${cliPath}" classify claude s1`],
    ["a heredoc", `node "${cliPath}" classify claude s1 <<'EOF'\n{}\nEOF`],
    ["a command after", `${own("{}")}; rm -rf x`],
    ["an and-list", `${own("{}")} && echo done`],
    ["a pipe out", `${own("{}")} | tee out.txt`],
    ["a redirect", `${own("{}")} > ~/.bashrc`],
    ["a command before", `cd /tmp && ${own("{}")}`],
    ["a variable", `X=1 ${own("{}")}`],
    ["a substitution outside the quotes", `${own("{}")}$(rm -rf x)`],
    ["a quote break-out", own(`{}'$(rm -rf x)'`)],
    ["a second word", `${own("{}")} '{}'`],
    ["trailing space", `${own("{}")} `],
    ["a multi-line answer", own('{\n"a":1}')],
    ["a non-object answer", own("[1]")],
    ["a non-JSON answer", own("not json")],
    ["an empty answer", own("")],
  ])("never approved: %s", (_, command) => {
    const d = recording().review(request(command), undefined, "PreToolUse");
    expect(d.decision).not.toBe("approve");
  });

  test("never approved with a custom environment or another directory", () => {
    for (const extra of [{ env: { A: "1" } }, { workdir: "/elsewhere" }, { stdin: "x" }]) {
      const r = { ...request(own()), input: { command: own(), ...extra } };
      expect(recording().review(r, undefined, "PreToolUse").decision).not.toBe("approve");
    }
  });

  test("without a known CLI path nothing is approved by this check", () => {
    const directory = join(root, `r${counter++}`);
    mkdirSync(directory, { mode: 0o700 });
    const s = new PolicySession(directory, "claude", "s1", permissive);
    expect(s.review(request(own()), undefined, "PreToolUse").decision).toBe("human");
  });

  test("a recorded classification approves the unchanged retry of the original", () => {
    const s = recording();
    const original = { ...ambiguous(), input: { command: "echo $RETRY", description: "first" } };
    const blocked = s.review(original, undefined, "PreToolUse");
    expect(blocked.classification).toBe("requested");
    const out = JSON.stringify(
      hookResponse("claude", "PreToolUse", blocked, { cliPath, sessionId: "s1" }),
    );
    const record = own(answer({ ...original, input: { command: "echo $RETRY" } }));
    expect(out).toContain(JSON.stringify(own("<json>")).slice(1, -1));
    expect(s.review(request(record), undefined, "PreToolUse").decision).toBe("approve");
    // What the CLI then sends the service.
    const classified = s.classify(JSON.parse(record.slice(record.indexOf("'") + 1, -1)));
    expect(classified.requestHash).toBe(blocked.requestHash);
    expect(classified.decision).toBe("approve");
    // The harness may relabel the retry; the hash ignores the description.
    const retry = { ...original, input: { ...original.input, description: "retry" } };
    expect(s.review(retry, undefined, "PreToolUse")).toMatchObject({
      decision: "approve",
      requestHash: blocked.requestHash,
    });
    expect(s.review(retry, undefined, "PermissionRequest").decision).toBe("approve");
  });
});

describe("review history", () => {
  test("a deny that was later approved is reported, with both attempts kept", async () => {
    const directory = join(root, `history-${counter++}`);
    mkdirSync(directory, { mode: 0o700 });
    const requestHash = "d".repeat(64);
    audit(directory, {
      event: "classification-requested",
      requestHash,
      redactedCommand: "echo $X",
      reason: "r",
    });
    audit(directory, {
      event: "classification",
      requestHash,
      category: "impactful-write",
      confidence: 0.8,
      recoverable: false,
    });
    audit(directory, {
      event: "decision",
      requestHash,
      decision: "deny",
      classification: "denied",
    });
    audit(directory, {
      event: "classification",
      requestHash,
      category: "code-read",
      confidence: 0.99,
      recoverable: true,
    });
    audit(directory, {
      event: "decision",
      requestHash,
      decision: "approve",
      classification: "approved",
    });
    audit(directory, {
      event: "decision",
      requestHash,
      decision: "approve",
      classification: "approved",
    });
    const review = await reviewClassifications([directory]);
    const [only] = review.aiApproved;
    expect(only?.attempts.map((t) => [t.outcome, t.confidence])).toEqual([
      ["denied", 0.8],
      ["approved", 0.99],
    ]);
    expect(review.deniedThenApproved).toHaveLength(1);
    expect(review.reclassified).toHaveLength(1);
    expect(review.histogram.reduce((n, b) => n + b.count, 0)).toBe(2);
    expect(formatReview(review)).toContain(
      "AI-denied, then approved on a later classification (1)",
    );
  });
});

describe("adapters", () => {
  test("Codex cannot ask, so a fallback is a deny that does not invite another classification", () => {
    const { session: s } = session();
    const r = ambiguous();
    s.review(r, undefined, "PreToolUse");
    const fallback = s.review(r, undefined, "PreToolUse");
    expect(fallback.classification).toBe("fallback");
    const text = JSON.stringify(hookResponse("codex", "PreToolUse", fallback));
    expect(text).toContain('"permissionDecision":"deny"');
    expect(text).not.toContain("Classify it");
    expect(text).toContain("run it themselves");
  });

  test("Copilot gets a deny with a reason; approvals and ordinary asks are unchanged", () => {
    const { session: s } = session();
    const d = s.review(ambiguous(), undefined, "PreToolUse");
    expect(hookResponse("copilot", "PreToolUse", d)).toMatchObject({
      permissionDecision: "deny",
    });
    const approved = evaluate(request("git status"), undefined, permissive);
    expect(hookResponse("copilot", "PreToolUse", approved)).toEqual({
      permissionDecision: "allow",
    });
    const human = evaluate(request("rm -rf x"), undefined, permissive);
    expect(hookResponse("claude", "PreToolUse", human)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
  });
});

describe("replay", () => {
  test("counts the escalations that go to classification instead of a person", () => {
    const file = join(root, "transcript.jsonl");
    const line = (command: string) =>
      JSON.stringify({
        cwd: work,
        message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
      });
    writeFileSync(
      file,
      [line("echo $ONE"), line("echo $TWO"), line("rm -rf build"), line("ls")].join("\n"),
    );
    const report = replayTranscripts([file], permissive);
    expect(report).toMatchObject({ commands: 4, approved: 1, classified: 2 });
  });
});

describe("request hash and classifier rule", () => {
  test("a label-only field does not change the hash; the command does", () => {
    const base = request("gh issue comment 1 --body hi");
    const a = { ...base, input: { ...base.input, description: "Comment on issue" } };
    const b = { ...base, input: { ...base.input, description: "Post a note" } };
    expect(requestHash(a)).toBe(requestHash(b));
    expect(requestHash(a)).toBe(requestHash(base));
    expect(evaluate(a, undefined, permissive).requestHash).toBe(
      evaluate(b, undefined, permissive).requestHash,
    );
    expect(requestHash(request("gh issue comment 2 --body hi"))).not.toBe(requestHash(base));
    const sandbox = { ...base, input: { ...base.input, dangerouslyDisableSandbox: true } };
    expect(requestHash(sandbox)).not.toBe(requestHash(base));
    // Outside shell tools a description can be content, such as an MCP work item body.
    const mcp = (description: string): Request => ({
      ...base,
      tool: "mcp__ado__create_work_item",
      input: { title: "t", description },
    });
    expect(requestHash(mcp("a"))).not.toBe(requestHash(mcp("b")));
    // The audit record correlates by the same hash as the decision, for shell and MCP requests.
    for (const r of [a, mcp("a")])
      expect(requestSummary(r).requestHash).toBe(evaluate(r, undefined, permissive).requestHash);
  });

  test("a classification survives a retry with a different description", () => {
    const { session: s } = session();
    const r = ambiguous();
    const first = { ...r, input: { ...r.input, description: "first" } };
    expect(s.review(first, undefined, "PreToolUse").decision).toBe("deny");
    expect(s.classify(verdict(r)).decision).toBe("approve");
    const retry = { ...r, input: { ...r.input, description: "second" } };
    expect(s.review(retry, undefined, "PreToolUse").decision).toBe("approve");
  });

  test("a recoverable impactful write is AI-approvable, and the hint says so", () => {
    const { session: s } = session();
    const r = ambiguous();
    const d = s.review(r, undefined, "PreToolUse");
    const out = JSON.stringify(hookResponse("claude", "PreToolUse", d));
    expect(out).toContain(HUMAN_REVIEW_PRINCIPLE);
    expect(s.classify(verdict(r, { category: "impactful-write", confidence: 0.95 })).decision).toBe(
      "approve",
    );
  });
});
