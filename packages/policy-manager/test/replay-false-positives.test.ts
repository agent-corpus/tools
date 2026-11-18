import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isProtectedPath } from "../src/evidence.js";
import { scriptRules } from "../src/hard.js";
import { parseProfile } from "../src/profile.js";
import { APPROVE_GUARD, PolicySession } from "../src/session.js";
import { codeTouchesState, stateDirs } from "../src/statepaths.js";
import type { Request } from "../src/types.js";

// Requests that asked a person in a replay of real transcripts although nothing in them could
// approve, read a credential, or change the policy service's state, next to the forms that must
// keep asking.
const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
const slash = (path: string) => path.replace(/\\/g, "/");
let root: string,
  state: string,
  scratch: string,
  counter = 0;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "replay-fp-test-")));
  scratch = slash(join(root, "scratchpad"));
  mkdirSync(scratch);
  state = slash(stateDirs()[0] ?? "");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function session() {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  return new PolicySession(directory, "claude", "s1", permissive, undefined, {
    classify: async () => {
      throw new Error("the classifier is not part of these checks");
    },
  });
}
const bash = (command: string, cwd = root): Request => ({
  sessionId: "s1",
  harness: "claude",
  cwd,
  tool: "Bash",
  input: { command },
});
const rules = (command: string, cwd = root) => [...scriptRules(command, cwd)];

describe("self-approve is running the CLI, not naming it", () => {
  test.each([
    "until npm view @agent-corpus/policy-manager@0.11.2 version >/dev/null 2>&1; do sleep 20; done",
    "for i in 1 2; do v=$(npm view @agent-corpus/policy-manager version); echo $v; done",
    "npm info @agent-corpus/policy-manager versions --json",
    "npm ls -g --prefix /tmp/p @agent-corpus/policy-manager",
    'P=/tmp/p; npm install --global --prefix "$P" --ignore-scripts @agent-corpus/policy-manager@0.11.2',
    "node -e 'console.log(require(process.argv[1]).version)' /x/lib/node_modules/@agent-corpus/policy-manager/package.json",
    'command -v pm || echo "no pm on PATH"',
    "git commit -q -m 'docs: an agent never runs pm approve'",
    "gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' -f t=X -f body='Fixed: pm approve is refused.'",
  ])("%s", async (command) => {
    const d = await session().decide(bash(command), "PreToolUse");
    expect(d.reason).not.toBe(APPROVE_GUARD);
    expect(d.hard).not.toBe("self-approve");
  });

  test.each([
    'C=/x/lib/node_modules/@agent-corpus/policy-manager/dist/cli.js; node "$C" setup-hook-claude',
    "node /x/lib/node_modules/@agent-corpus/policy-manager/dist/cli.js setup-hook-claude",
    'python3 -c \'import subprocess; subprocess.run(["pm", "approve", "--last"])\'',
    'node -e \'require("child_process").execSync("pm stop claude s1")\'',
    "node --input-type=module -e 'await import(\"/x/node_modules/@agent-corpus/policy-manager/dist/index.js\")'",
    "cat run.sh | sh # pm approve --last",
    "printf 'pm approve --last\\n' > a.sh; sh a.sh",
    "pm help && pm approve --last",
  ])("still self-approve: %s", async (command) => {
    const d = await session().decide(bash(command), "PreToolUse");
    expect(d.hard).toBe("self-approve");
  });
});

describe("policy-state needs a target that can reach the state", () => {
  test.each([
    // A transcript, by the first argument after the code.
    () =>
      `node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/x/g,"y"))' ${slash(homedir())}/.claude/projects/p/s.jsonl`,
    // Source text that mentions acp and comment openers, written to literal files.
    () =>
      `node -e 'const fs=require("fs");let f="src/a.ts";let s=fs.readFileSync(f,"utf8");s=s.replace("/** a */","/** acp-501-x */");fs.writeFileSync(f,s);fs.writeFileSync("src/b.ts",s)'`,
    () =>
      "python3 - <<'EOF'\np='src/a.ts'; s=open(p).read()\ns=s.replace('/** old */', '''/** acp-<uid>-* and tmpdir() */''')\nopen(p,'w').write(s)\nEOF",
    // Scratchpad writes through a variable assigned a literal, after cd into the temp root.
    () =>
      `cd /tmp && F=${scratch}/pr-body.md && gh pr view 5 --json body -q .body > $F && printf x >> $F`,
    () => `D=${scratch}/merge-ready; mkdir -p $D; cat > $D/52.md <<'EOF'\nbody\nEOF`,
    () =>
      `find ${slash(homedir())}/.claude/projects -name "*.jsonl" -newermt "2026-11-16 22:20" -not -path "*/subagents/*"`,
  ])("%#", (make) => expect(rules(make())).not.toContain("policy-state"));

  test.each([
    () => `false || F=${state}/grants.json; echo x > $F`,
    // Not certain: the 0.11.2 decision.
    () => `cd ${state} && grep -c decision audit.jsonl`,
    () => `TMPDIR=/opt/x | true; echo x > $TMPDIR/acp-*/grants.json`,
    () => `: \${X:=${state}}; echo x > $X/grants.json`,
    () => `F=${state}/grants.json; echo x > $F`,
    () => `for f in ${state}/grants.json; do echo x > $f; done`,
    () => `node -e 'require("fs").writeFileSync(process.argv[1],"x")' ${state}/grants.json`,
    () => `node -e 'require("fs").writeFileSync(process.argv[1],"x")' "$X"`,
    () =>
      `node -e 'const f="src/a.ts";const w=require("fs").writeFileSync;w(require("os").tmpdir()+"/acp-1/grants.json","")'`,
    () => `python3 -c 'import subprocess; subprocess.run("rm -rf /tmp/acp-*", shell=True)'`,
    () =>
      `python3 - <<'EOF'\ndef put(p): open(p, 'w').write('x')\nput('${state}/grants.json')\nEOF`,
  ])("still policy-state %#", (make) => expect(rules(make())).toContain("policy-state"));

  test("a literal token path in interpreter code is a credential read; inside text it is data", () => {
    expect(rules(`python3 - <<'EOF'\nprint(open('${state}/token').read())\nEOF`)).toContain(
      "credential-read",
    );
    expect(
      rules(`python3 - <<'EOF'\ns='a test reads ${state}/token here'\nprint(len(s))\nEOF`),
    ).not.toContain("credential-read");
  });

  test("codeTouchesState reads process.argv words passed literally", () => {
    const code = 'require("fs").writeFileSync(process.argv[1], "x")';
    expect(codeTouchesState(code, [root], { argv: [`${scratch}/x.md`] })).toBe(false);
    expect(codeTouchesState(code, [root], { argv: [`${state}/grants.json`] })).toBe(true);
    expect(codeTouchesState(code, [root], { argv: [undefined] })).toBe(true);
  });
});

describe("gh api graphql with variable fields", () => {
  const resolve = "mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}";
  test.each([
    `for t in PRRT_a PRRT_b; do gh api graphql -f query='${resolve}' -f t=$t; done`,
    `R='${resolve}'; gh api graphql -f query="$R" -f t=PRRT_a`,
    'for n in 28 29; do gh api graphql -f query=\'query($n:Int!){repository(owner:"o",name:"r"){pullRequest(number:$n){id}}}\' -F n=$n; done',
  ])("an allow-listed mutation or a query is not repo-delete: %s", (command) =>
    expect(rules(command)).not.toContain("repo-delete"),
  );
  test.each([
    'gh api graphql -f query="$Q"',
    'Q=\'mutation{deleteRepository(input:{repositoryId:"x"}){clientMutationId}}\'; gh api graphql -f query="$Q"',
    `gh api graphql -f query='${resolve}' -f t=$t`,
    `for t in "a -X" b; do gh api graphql -f query='${resolve}' -f t=$t; done`,
    `t=a; t=b; gh api graphql -f query='${resolve}' -f t=$t`,
    `read t; gh api graphql -f query='${resolve}' -f t=$t`,
    "gh run rerun 1 --failed",
  ])("still repo-delete: %s", (command) => expect(rules(command)).toContain("repo-delete"));
});

describe("a path under .claude/worktrees/<name> is judged inside that worktree", () => {
  test.skipIf(process.platform === "win32")("a file there is not protected; settings are", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const gone = join(repo, ".claude", "worktrees", "gone");
    expect(isProtectedPath(join(gone, "merge-ready-80.md"))).toBe(false);
    expect(isProtectedPath(join(gone, ".claude", "settings.json"))).toBe(true);
    expect(isProtectedPath(join(gone, ".agent-config", "x.md"))).toBe(true);
    expect(isProtectedPath(join(repo, ".claude", "settings.json"))).toBe(true);
  });
});

describe("Claude Code's auto-memory: Markdown files in projects/<project>/memory/", () => {
  let config: string, memory: string, previous: string | undefined;
  beforeAll(() => {
    previous = process.env.CLAUDE_CONFIG_DIR;
    config = slash(join(root, "home", ".claude"));
    memory = `${config}/projects/-Users-me-code-app/memory`;
    mkdirSync(memory, { recursive: true });
    writeFileSync(`${memory}/MEMORY.md`, "# Memory\n");
    mkdirSync(join(root, "elsewhere"));
    mkdirSync(`${config}/projects/linked`, { recursive: true });
    symlinkSync(join(root, "elsewhere"), `${config}/projects/linked/memory`);
    symlinkSync(join(root, "elsewhere", "x.md"), `${memory}/link.md`);
    process.env.CLAUDE_CONFIG_DIR = config;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  const tool = (name: string, input: Record<string, unknown>): Request => ({
    sessionId: "s1",
    harness: "claude",
    cwd: root,
    tool: name,
    input,
  });

  test.skipIf(process.platform === "win32").each([
    () => tool("Write", { file_path: `${memory}/MEMORY.md`, content: "x" }),
    () => tool("Write", { file_path: `${memory}/feedback_terse.md`, content: "x" }),
    () => tool("Edit", { file_path: `${memory}/MEMORY.md`, old_string: "a", new_string: "b" }),
    // A project whose memory directory does not exist yet: Claude Code creates it.
    () => tool("Write", { file_path: `${config}/projects/-new/memory/MEMORY.md`, content: "x" }),
    () => bash(`echo "- [x](x.md) — y" >> ${memory}/MEMORY.md`),
    () => bash(`cat > ${memory}/note.md <<'EOF'\nx\nEOF`),
  ])("approved %#", async (make) => {
    const d = await session().decide(make(), "PreToolUse");
    expect(d.decision).toBe("approve");
  });

  test
    .skipIf(process.platform === "win32")
    .each([
      () => tool("Write", { file_path: `${config}/settings.json`, content: "{}" }),
      () => tool("Write", { file_path: `${config}/CLAUDE.md`, content: "x" }),
      () => tool("Write", { file_path: `${config}/hooks/x.md`, content: "x" }),
      () => tool("Write", { file_path: `${config}/agents/x.md`, content: "x" }),
      () =>
        tool("Write", { file_path: `${config}/projects/-Users-me-code-app/s.jsonl`, content: "x" }),
      () => tool("Write", { file_path: `${memory}/s.jsonl`, content: "x" }),
      () => tool("Write", { file_path: `${memory}/sub/x.md`, content: "x" }),
      () => tool("Write", { file_path: `${memory}/../x.md`, content: "x" }),
      () => tool("Write", { file_path: `${memory}/../../../settings.md`, content: "x" }),
      () => tool("Write", { file_path: `${config}/projects/linked/memory/x.md`, content: "x" }),
      () => tool("Write", { file_path: `${memory}/link.md`, content: "x" }),
      () => bash(`echo x >> ${config}/settings.json`),
      () => bash(`echo x > ${memory}/../MEMORY.md`),
    ])("still asks %#", async (make) => {
    const d = await session().decide(make(), "PreToolUse");
    expect(d.decision).not.toBe("approve");
  });
});
