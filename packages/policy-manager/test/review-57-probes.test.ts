import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { audit, sessionDirectory, sessionToken } from "../src/audit.js";
import { parseProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

// Every probe from the review of PR #57, with the outcome 0.11.2 gave it in this same setup: a
// permissive profile and a classifier that approves everything, so `AI` means a classifier decides
// and `eng` means the engine approves. A probe may only get stricter, except the loosenings this
// release makes on purpose.
interface Probe {
  set: string;
  probe: string;
  base: string;
}
const probes: Probe[] = JSON.parse(
  readFileSync(new URL("./fixtures/review-57-probes.json", import.meta.url), "utf8"),
);
const LOOSENED = new Set([
  // Claude Code's auto-memory: a Markdown file written directly in projects/<project>/memory/.
  "echo hi >> $CFG/projects/p/memory/MEMORY.md",
  '{"tool":"Write","input":{"file_path":"$CFG/projects/p/memory/new.md","content":"x"}}',
  "tee $CFG/projects/p/memory/a.md < /dev/null",
  // A commit message that mentions the CLI is data.
  'git commit -m "docs: explain pm approve --last"',
  // An allow-listed literal mutation with a variable from a literal loop list.
  "for t in a b; do gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id}}}' -f t=$t; done",
]);
const rank = (outcome: string) =>
  outcome === "eng"
    ? 0
    : outcome === "AI"
      ? 1
      : outcome === "human" || outcome === "native"
        ? 2
        : 3;

let root: string, cwd: string, cfg: string, dir: string, previous: string | undefined;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "probe57-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (at: string, ...args: string[]) =>
    execFileSync("git", ["-C", at, ...args], { stdio: "ignore" });
  git(repo, "init", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
  cwd = join(repo, ".worktrees", "feat");
  git(repo, "worktree", "add", "-b", "feat/probe", cwd);
  cfg = join(root, "home", ".claude");
  mkdirSync(join(cfg, "agents"), { recursive: true });
  mkdirSync(join(cfg, "projects", "p", "memory"), { recursive: true });
  writeFileSync(join(cfg, "CLAUDE.md"), "x");
  writeFileSync(join(cfg, "projects", "p", "memory", "a.md"), "x");
  dir = sessionDirectory("codex", `probe57-${process.pid}`);
  sessionToken(dir);
  audit(dir, { event: "x" });
  previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
});
afterAll(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("review-57 probes never get looser", () => {
  test.each(probes.map((p) => [p.set, p.base, p.probe] as const))(
    "%s (0.11.2: %s): %s",
    async (_set, base, probe) => {
      const fill = (text: string) =>
        text
          .replaceAll("$DIR", dir)
          .replaceAll("$TD", tmpdir().replace(/[\\/]$/, ""))
          .replaceAll("$CWD", cwd)
          .replaceAll("$CFG", cfg)
          .replaceAll("$HOME", homedir());
      let calls = 0;
      const directory = realpathSync(mkdtempSync(join(root, "s-")));
      const session = new PolicySession(
        directory,
        "codex",
        "s1",
        parseProfile(JSON.stringify({ version: 1, mode: "permissive" })),
        "/usr/local/lib/node_modules/@agent-corpus/policy-manager/dist/cli.js",
        {
          classify: async (cli) => {
            calls++;
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
        },
      );
      const text = fill(probe);
      const request: Pick<Request, "tool" | "input"> = text.startsWith('{"tool')
        ? JSON.parse(text)
        : { tool: "Bash", input: { command: text } };
      const d = await session.decide(
        { sessionId: "s1", harness: "codex", cwd, ...request },
        "PreToolUse",
      );
      const outcome = d.decision === "approve" ? (calls ? "AI" : "eng") : (d.hard ?? d.decision);
      if (!LOOSENED.has(probe)) expect(rank(outcome)).toBeGreaterThanOrEqual(rank(base));
    },
  );
});
