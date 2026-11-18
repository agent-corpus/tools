import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hardRules } from "../src/hard.js";
import { evaluate, POLICY_STATE_REASON } from "../src/policy.js";
import { parseProfile } from "../src/profile.js";
import { codeTouchesState, stateDirs } from "../src/statepaths.js";
import type { Request } from "../src/types.js";

// Inline interpreter code that edits a temp file outside the policy service's state is not a
// policy-state change. A literal path is read as one whether it is a string, `Path(...)`,
// `open(...)` or `os.path.join` of literals, directly or through a variable assigned once; a
// string method is not a file call; data is not a target.
const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
const slash = (path: string) => path.replace(/\\/g, "/");
let root: string, worktree: string, state: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "interpreter-state-test-")));
  const repo = join(root, "other-repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
  worktree = join(repo, ".worktrees", "feat");
  git(repo, "worktree", "add", "-b", "feat/preview", worktree);
  // A session directory, as the service lays it out, named by its real path.
  state = slash(stateDirs().find((dir) => !dir.endsWith("0123456789abcdef01234567")) ?? "");
  if (!state) state = slash(stateDirs()[0] ?? "");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const python = (code: string): Request => ({
  sessionId: "s",
  harness: "codex",
  cwd: worktree,
  tool: "exec_command",
  input: { command: `python3 - <<'PY'\n${code}PY` },
});
const preview = (file: string) => `from pathlib import Path
p=Path('${file}')
s=p.read_text().replace('resolve:{dedupe:', 'resolve:{alias:{"@":"'+str(Path.cwd()/'src/caredocs.client/src')+'"},dedupe:')
p.write_text(s)
`;

describe("the live Codex command", () => {
  test("editing /tmp/gg-preview-server.mjs from a feature worktree of another repo is approved", () => {
    const request = python(preview("/tmp/gg-preview-server.mjs"));
    const d = evaluate(request, undefined, permissive);
    expect(d.decision).toBe("approve");
    expect(hardRules(request, { ...d, decision: "human" })).not.toContain("policy-state");
  });

  test("the same edit of a file in a policy session directory is hard policy-state", () => {
    // The audit log: state, but not a secret, so the rule is policy-state alone.
    const request = python(
      preview(`${slash(tmpdir())}/acp-501-0123456789abcdef01234567/audit.jsonl`),
    );
    const d = evaluate(request, undefined, permissive);
    expect(d.decision).toBe("human");
    expect(d.hard).toBe("policy-state");
    expect(d.reason).toBe(POLICY_STATE_REASON);
    expect(d.reason).not.toMatch(/cloud|repository|publishing/);
  });

  test("the session directory named by its real path is hard too", () => {
    const real = slash(realpathSync(tmpdir()));
    const request = python(preview(`${real}/acp-501-0123456789abcdef01234567/audit.jsonl`));
    expect(evaluate(request, undefined, permissive).hard).toBe("policy-state");
    // A secret there (the token) is hard as well, by the credential rule.
    const token = python(preview(`${real}/acp-501-0123456789abcdef01234567/token`));
    expect(evaluate(token, undefined, permissive).decision).toBe("human");
    expect(["policy-state", "credential-read"]).toContain(
      evaluate(token, undefined, permissive).hard,
    );
  });
});

describe("literal paths", () => {
  const cwds = () => [worktree];
  const inState = () => `${state}/token`;
  test.each([
    "p = Path('/tmp/pm-x/a.md')\np.write_text('x')\n",
    'p = pathlib.Path("/tmp/pm-x/a.md")\np.write_bytes(b"x")\n',
    "Path('/tmp/pm-x/a.md').write_text('x')\n",
    "f = open('/tmp/pm-x/a.md', 'w')\nf.write('x')\n",
    "with open('/tmp/pm-x/a.md', 'w') as f:\n    f.write('x')\n",
    "p = os.path.join('/tmp', 'pm-x', 'a.md')\nos.remove(p)\n",
    "os.remove(os.path.join('/tmp', 'pm-x', 'a.md'))\n",
    "os.replace('/tmp/pm-x/a', '/tmp/pm-x/b')\n",
  ])("outside the state: %s", (code) => {
    expect(codeTouchesState(code, cwds())).toBe(false);
  });
  test.each([
    (s: string) => `p = Path('${s}')\np.write_text('x')\n`,
    (s: string) => `p = os.path.join('${s.slice(0, s.lastIndexOf("/"))}', 'token')\nos.remove(p)\n`,
    (s: string) => `f = open('${s}', 'w')\nf.write('x')\n`,
    (s: string) => `Path('${s}').unlink()\n`,
  ])("inside the state: %#", (make) => {
    expect(codeTouchesState(make(inState()), cwds())).toBe(true);
  });
  test.each([
    // Assigned twice, or to something computed: not a literal, so it fails closed.
    "p = Path('/tmp/pm-x/a')\np = Path(name)\np.unlink()\n",
    "p = Path('/tmp/pm-x/a').read_text()\nos.remove(p)\n",
    "p = Path(os.environ['X'])\np.write_text('x')\n",
    "p = os.path.join('/tmp', name)\nos.remove(p)\n",
  ])("computed paths fail closed: %s", (code) => {
    expect(codeTouchesState(code, cwds())).toBe(true);
  });
  test("a directory above the state (the temp root itself) still counts for a delete", () => {
    expect(codeTouchesState(`import shutil\nshutil.rmtree('${slash(tmpdir())}')\n`, cwds())).toBe(
      true,
    );
  });
});

describe("string methods are not file calls", () => {
  test.each([
    "s = 'a/b'\nt = s.replace('a', 'b')\nos.remove('/tmp/pm-x/a')\n",
    "x = Path(name).read_text().replace('a', 'b')\n",
    "x = '..'.replace('.', '/')\n",
    "x = Path(name).replace('a', 'b')\n",
    "items.remove(name)\n",
    "d.rename(columns={'a': 'b'})\n",
  ])("%s", (code) => {
    expect(codeTouchesState(code, [worktree])).toBe(false);
  });
  test.each([
    "name = sys.argv[1]\nPath(name).replace(target)\n",
    "name = os.environ['X']\nos.replace(name, other)\n",
    "os.rename(name, '/tmp/pm-x/b')\n",
    "Path(name).rename('/tmp/pm-x/b')\n",
  ])("a path method or module call with a computed path fails closed: %s", (code) => {
    expect(codeTouchesState(code, [worktree])).toBe(true);
  });
});

describe("data is not a target", () => {
  test.each([
    "Path('/tmp/pm-x/a').write_text(str(Path.cwd() / 'src'))\n",
    "p = Path('/tmp/pm-x/a')\np.write_text(os.environ.get('HOME', '') + name)\n",
    "open('/tmp/pm-x/a', 'w').write(name + str(Path.cwd()))\n",
  ])("%s", (code) => {
    expect(codeTouchesState(code, [worktree])).toBe(false);
  });
});
