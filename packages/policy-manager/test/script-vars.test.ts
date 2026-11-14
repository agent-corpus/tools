import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { evaluate } from "../src/policy.js";
import { parseProfile } from "../src/profile.js";
import type { Request } from "../src/types.js";

const profile = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
const posix = (path: string) => path.split("\\").join("/");
let root: string;
let worktree: string;

function git(cwd: string, args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}
function decide(command: string, cwd = worktree) {
  const r: Request = { sessionId: "t", harness: "claude", cwd, tool: "Bash", input: { command } };
  return evaluate(r, undefined, profile);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "script-vars-test-"));
  const main = join(root, "main");
  worktree = join(root, "wt");
  execFileSync("git", ["init", "-b", "main", main], { stdio: "ignore" });
  git(main, ["config", "user.name", "T"]);
  git(main, ["config", "user.email", "t@example.com"]);
  writeFileSync(join(main, "a.txt"), "a");
  git(main, ["add", "a.txt"]);
  git(main, ["commit", "-m", "init"]);
  git(main, ["worktree", "add", "-b", "feature", worktree]);
  mkdirSync(join(worktree, "src"), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("same-script variables", () => {
  test.each([
    // a literal assignment cannot fail, so an && chain of them always runs to the end
    "S=src && H=a.txt; ls $S/$H",
    "S=src && T=$S/x && U=$T/y; echo $U; ls $S",
    "A=src && B=$A && C=$B; ls $C",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax under test
    "S=src && H=a.txt; ls ${S}/${H}",
    'S=src && H=a.txt; grep -n x "$S/$H"',
    "S='src' && H=\"a.txt\"; ls $S/$H",
    "S=src && Q='a b'; echo \"$Q\"; ls $S",
    "S=src && H=a.txt && ls $S; cat $S/$H",
    "S=src H=a.txt && ls $S; cat $H",
  ])("approves %j", (command) => expect(decide(command).decision).toBe("approve"));

  test.each([
    // the assignment may not have run: the environment value is possible
    ["ls || X=src; ls $X", "unknown"],
    ["false && X=src; ls $X", "unknown"],
    ["ls && X=src; ls $X", "unknown"],
    ["S=src && ls nope && H=a.txt; ls $H", "unknown"],
    ["if true; then X=src; fi; ls $X", "unknown"],
    ["for i in a; do X=src; done; ls $X", "unknown"],
    ["while false; do X=src; done; ls $X", "unknown"],
    ["(X=src) && H=a; ls $X", "unknown"],
    ["(X=src); ls $X", "unknown"],
    ["X=src | cat; ls $X", "unknown"],
    ["{ X=src; } && H=a; ls $H", "unknown"],
    // an assignment that can fail does not let the chain go on
    ["S=$(ls) && H=a.txt; ls $H", "unknown"],
    ["S=`ls` && H=a.txt; ls $H", "unknown"],
    ["S=src >/dev/null && H=a.txt; ls $H", "unknown"],
    ["UID=src && H=a.txt; ls $H", "unknown"],
    ["SECONDS=src && H=a.txt; ls $H", "unknown"],
    ["BASH_ARGV0=x && H=a.txt; ls $H", "unknown"],
    ["s=src && h=a.txt; ls $h", "unknown"],
    ["export S=src && H=a.txt; ls $H", "unknown"],
    // a prefix assignment lasts for one command only
    ["X=src ls && H=a; ls $X", "unknown"],
    ["X=rm true; $X -rf y", "unknown"],
    // later changes make the value unknown again
    ["S=src && H=a.txt; unset H; ls $H", "unknown"],
    ["S=src && H=a.txt; read H; ls $H", "unknown"],
    ["S=src && H=a.txt; H=$(ls); cat $H", "unknown"],
    ["S=src && H=a.txt; for H in $(ls); do :; done; cat $H", "unknown"],
    // a value that splits or globs unquoted is unknown
    ["S=src && X='a.txt b'; ls $X", "unknown"],
    ["S=src && X='src/*'; ls $X", "unknown"],
    // a value that names a program, option, credential or protected path is judged as that
    ["S=src && P=rm; $P -rf y", "destructive"],
    ["S=src && P=rm && F=-rf; $P $F y", "destructive"],
    ["S=src && P=git; $P push --force origin x", "destructive"],
    ["S=src && K=.ssh; cat ~/$K/id_rsa", "sensitive"],
    ["S=src && C=.claude/settings.json; echo x > $C", "sensitive"],
    ["S=src && W=.github/workflows; echo x > $W/ci.yml", "sensitive"],
    ["S=src && X=cd; $X /etc", "unknown"],
    // every value the chain can stop with is judged
    ["X=rm && false && X=ls; $X -rf y", "destructive"],
    ["X=ls && X=rm && false; $X -rf y", "destructive"],
  ])("sends %j to a human (%s)", (command, category) => {
    const d = decide(command);
    expect(d.decision).toBe("human");
    expect(d.category).toBe(category);
  });

  test.skipIf(process.platform === "win32")("absolute values after a leading cd", () => {
    const wt = posix(worktree);
    expect(decide(`cd ${wt} && W=${wt}/src && T=$W; grep -rn foo $T`).decision).toBe("approve");
    expect(decide(`W=${wt} && T=$W/src; grep -rn foo $T; ls $W`).decision).toBe("approve");
    expect(decide(`W=${wt} && T=$W/src; rm -rf $T`).decision).toBe("human");
  });
});
