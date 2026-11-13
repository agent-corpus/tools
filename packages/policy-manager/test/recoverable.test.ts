import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { evaluate, hash } from "../src/policy.js";
import { parseProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

const links = process.platform !== "win32";
// Every decision here reads live Git evidence, which is slow on Windows runners.
vi.setConfig({ testTimeout: 30_000 });
let root: string, repo: string, wt: string, outside: string;
const profile = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-c", "protocol.file.allow=always", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function decide(command: string, cwd = wt) {
  const r: Request = { sessionId: "t", harness: "claude", cwd, tool: "Bash", input: { command } };
  return evaluate(r, undefined, profile).decision;
}
/** Runs `change`, checks, then puts the worktree back to HEAD with the fixture's loose files. */
function scenario(change: () => void, check: () => void) {
  try {
    change();
    check();
  } finally {
    git(wt, ["reset", "-q", "--hard", "HEAD"]);
    git(wt, ["update-index", "--no-assume-unchanged", "a.txt"]);
    rmSync(join(wt, "late.txt"), { force: true });
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "recoverable-test-"));
  const origin = join(root, "origin.git");
  const subOrigin = join(root, "sub.git");
  repo = join(root, "repo");
  wt = join(root, "wt");
  outside = join(root, "outside");
  write(join(outside, "o.txt"), "outside");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", subOrigin]);
  const subSeed = join(root, "sub-seed");
  execFileSync("git", ["clone", "-q", subOrigin, subSeed], { stdio: "ignore" });
  for (const cwd of [subSeed]) {
    git(cwd, ["config", "user.name", "T"]);
    git(cwd, ["config", "user.email", "t@example.com"]);
  }
  write(join(subSeed, "s.txt"), "s");
  git(subSeed, ["add", "."]);
  git(subSeed, ["commit", "-qm", "s"]);
  git(subSeed, ["push", "-q", "origin", "main"]);

  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  git(repo, ["config", "user.name", "T"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  write(join(repo, "a.txt"), "a");
  write(join(repo, "dir", "b.txt"), "b");
  write(join(repo, "dir", "c.txt"), "c");
  write(join(repo, "mixed", "t.txt"), "t");
  write(join(repo, "ign", "kept.txt"), "kept");
  write(join(repo, ".gitignore"), "*.log\n");
  write(join(repo, ".github", "w.yml"), "w");
  if (links) {
    symlinkSync("dir", join(repo, "link"));
    symlinkSync(outside, join(repo, "outlink"));
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "one"]);
  git(repo, ["submodule", "add", "-q", subOrigin, "sub"]);
  git(repo, ["commit", "-qm", "sub"]);
  write(join(repo, "two.txt"), "2");
  write(join(repo, "=node"), "a tracked file whose name zsh would expand");
  git(repo, ["add", "two.txt", "=node"]);
  git(repo, ["commit", "-qm", "two"]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  git(repo, ["checkout", "-q", "-b", "withf"]);
  write(join(repo, "f.txt"), "from git");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-qm", "f"]);
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["worktree", "add", "-q", "-b", "feature", wt]);
  git(wt, ["submodule", "update", "-q", "--init"]);
  write(join(wt, "mixed", "u.txt"), "untracked sibling");
  write(join(wt, "ign", "x.log"), "ignored");
  write(join(wt, "new.txt"), "untracked");
  if (links) symlinkSync("a.txt", join(wt, "newlink"));
  // Untracked user files, born well before any approval in the tests.
  for (const name of ["user1.md", "user2.md", "user3.md", "user4.md", "user5.md"])
    write(join(wt, "user", name), `user notes ${name}`);
  const born = Date.now() + 300;
  while (Date.now() < born) {
    /* let the user files' birth times fall outside the approval slack */
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("recoverable rm", () => {
  test.each([
    "rm a.txt",
    "rm -f a.txt dir/b.txt",
    "rm -- a.txt",
    "rm -rf dir",
    "rm -r dir/",
    "rm -fv ./dir/b.txt",
    "rm mixed/t.txt",
    "ls && rm a.txt; echo done",
    "rm a.txt && rm -r dir",
  ])("approves %s", (command) => expect(decide(command)).toBe("approve"));

  test.each([
    "rm new.txt",
    "rm -rf mixed",
    "rm -rf ign",
    "rm ign/x.log",
    "rm -rf .",
    "rm -rf ./",
    "rm -rf ../wt",
    "rm -rf dir/..",
    "rm -rf *",
    "rm -f '*.txt'",
    "rm -f dir/?.txt",
    "rm -f 'dir/[bc].txt'",
    "rm a.txt -rf",
    "rm -- -f",
    "rm missing.txt",
    "rm -rf sub",
    "rm sub/s.txt",
    "rm .github/w.yml",
    "rm .gitignore .git/config",
    "rm -I a.txt",
    "rm --no-preserve-root -rf dir",
    "rm -P a.txt",
    "rm",
    "mv new.txt a.txt; rm a.txt",
    "cp new.txt a.txt && rm a.txt",
    "echo x > a.txt && rm a.txt",
    "bash -c 'rm a.txt'",
    "env rm a.txt",
    "A=1 rm a.txt",
    "command rm a.txt",
    "/bin/rm a.txt",
    "rm $(echo a.txt)",
    "f=a.txt; rm $f",
    "rm a.txt | cat",
    "unlink a.txt",
    "git clean -fd",
  ])("sends %s to a human", (command) => expect(decide(command)).toBe("human"));

  test("the main clone and an absolute path outside the worktree stay human", () => {
    expect(decide("rm a.txt", repo)).toBe("human");
    expect(decide(`rm ${join(repo, "a.txt")}`)).toBe("human");
    // Backslash paths are never approved; the shell reads them as escapes.
    expect(decide(`rm ${join(wt, "a.txt")}`)).toBe(links ? "approve" : "human");
  });

  test("a modified, staged, or assume-unchanged file stays human", () => {
    scenario(
      () => write(join(wt, "a.txt"), "changed"),
      () => expect(decide("rm a.txt")).toBe("human"),
    );
    scenario(
      () => {
        write(join(wt, "a.txt"), "staged");
        git(wt, ["add", "a.txt"]);
        write(join(wt, "a.txt"), "a");
      },
      () => {
        expect(decide("rm a.txt")).toBe("human");
        expect(decide("git rm -f a.txt")).toBe("human");
      },
    );
    scenario(
      () => {
        git(wt, ["update-index", "--assume-unchanged", "a.txt"]);
        write(join(wt, "a.txt"), "hidden change");
      },
      () => expect(decide("rm a.txt")).toBe("human"),
    );
    scenario(
      () => write(join(wt, "dir", "b.txt"), "changed"),
      () => expect(decide("rm -rf dir")).toBe("human"),
    );
  });

  test.skipIf(!links)("symlinks are judged by what is removed", () => {
    expect(decide("rm link")).toBe("approve"); // the tracked link itself
    expect(decide("rm link/b.txt")).toBe("approve"); // resolves to dir/b.txt
    expect(decide("rm outlink")).toBe("approve");
    expect(decide("rm outlink/o.txt")).toBe("human");
    expect(decide("rm -r outlink/")).toBe("human");
    expect(decide("rm newlink")).toBe("human"); // untracked link
  });
});

describe("cd into a worktree", () => {
  // A Windows path in shell text has backslashes, which are escapes; such commands stay human.
  test.skipIf(!links)("`cd <worktree> && rm` is judged only in the worktree", () => {
    expect(decide(`cd ${wt} && rm a.txt`, repo)).toBe("approve");
    expect(decide(`cd ${wt} && rm -r dir && rm a.txt`, repo)).toBe("approve");
    expect(decide(`cd ${wt}; rm a.txt`, repo)).toBe("human"); // runs in the main clone if cd fails
    expect(decide(`cd ${wt} && ls || rm a.txt`, repo)).toBe("human");
    expect(decide(`cd ${wt} || rm a.txt`, repo)).toBe("human");
  });
});

describe("files this session created", () => {
  let n = 0;
  function session(id = `s${n++}`) {
    const directory = mkdtempSync(join(root, "audit-"));
    return new PolicySession(directory, "claude", id, profile);
  }
  const bash = (s: PolicySession, command: string, cwd = wt): Request => ({
    sessionId: s.sessionId,
    harness: "claude",
    cwd,
    tool: "Bash",
    input: { command },
  });
  /** Approves, runs and reports a Write of `file` in the worktree, as the hooks would. */
  function create(s: PolicySession, file: string, text = "probe") {
    const r: Request = {
      sessionId: s.sessionId,
      harness: "claude",
      cwd: wt,
      tool: "Write",
      input: { file_path: join(wt, file), content: text },
    };
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("approve");
    write(join(wt, file), text);
    s.record({ requestHash: hash(r), event: "execution-result", status: "succeeded" });
  }
  const rm = (s: PolicySession, command: string, cwd = wt) =>
    s.review(bash(s, command, cwd), undefined, "PreToolUse");
  const cleanup = (...files: string[]) => {
    for (const file of files) rmSync(join(wt, file), { recursive: true, force: true });
  };

  test("its own untracked file is removed without a prompt, also after cd", () => {
    const s = session();
    create(s, "probe.mjs");
    try {
      expect(rm(s, "rm probe.mjs").decision).toBe("approve");
      expect(rm(s, "rm -f probe.mjs").decision).toBe("approve");
      if (links) expect(rm(s, `cd ${wt} && rm probe.mjs`, repo).decision).toBe("approve");
      expect(rm(s, "rm probe.mjs a.txt").decision).toBe("approve");
    } finally {
      cleanup("probe.mjs");
    }
  });

  test("a file a shell redirect created counts too", () => {
    const s = session();
    const r = bash(s, "echo hi > made.txt");
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("approve");
    write(join(wt, "made.txt"), "hi\n");
    s.record({ requestHash: hash(r), event: "execution-result", status: "succeeded" });
    try {
      expect(rm(s, "rm made.txt").decision).toBe("approve");
    } finally {
      cleanup("made.txt");
    }
  });

  test("another session's file, a changed file, or -r goes to the classifier", () => {
    const s = session();
    create(s, "probe.mjs");
    try {
      const other = rm(session(), "rm probe.mjs");
      expect(other).toMatchObject({ decision: "deny", classification: "requested" });
      expect(rm(s, "rm -r probe.mjs").decision).not.toBe("approve");
      appendFileSync(join(wt, "probe.mjs"), "changed elsewhere");
      expect(rm(s, "rm probe.mjs")).toMatchObject({ tier: "ambiguous" });
      expect(rm(s, "rm new.txt")).toMatchObject({ tier: "ambiguous" }); // never this session's
    } finally {
      cleanup("probe.mjs");
    }
  });

  test.skipIf(!links)("a symlink or hard link swapped in after creation is not its file", () => {
    const s = session();
    create(s, "probe.mjs");
    try {
      rmSync(join(wt, "probe.mjs"));
      symlinkSync(join(outside, "o.txt"), join(wt, "probe.mjs"));
      expect(rm(s, "rm probe.mjs").decision).not.toBe("approve");
      rmSync(join(wt, "probe.mjs"));
      linkSync(join(outside, "o.txt"), join(wt, "probe.mjs"));
      expect(rm(s, "rm probe.mjs").decision).not.toBe("approve");
    } finally {
      cleanup("probe.mjs");
    }
  });

  test("a directory holding its files and others is not approved", () => {
    const s = session();
    create(s, "scratchdir/mine.txt");
    write(join(wt, "scratchdir", "theirs.txt"), "not this session's");
    try {
      expect(rm(s, "rm -r scratchdir").decision).not.toBe("approve");
      expect(rm(s, "rm scratchdir/mine.txt").decision).toBe("approve");
      expect(rm(s, "rm scratchdir/theirs.txt").decision).not.toBe("approve");
    } finally {
      cleanup("scratchdir");
    }
  });

  test("a file git checkout overwrote after creation is not its file", () => {
    const s = session();
    create(s, "f.txt", "session text");
    try {
      git(wt, ["checkout", "withf", "--", "f.txt"]);
      expect(rm(s, "rm f.txt").decision).not.toBe("approve");
    } finally {
      git(wt, ["reset", "-q", "--hard", "HEAD"]);
      cleanup("f.txt");
    }
  });

  test("mv or a patch move of someone else's file does not make it the session's", () => {
    const s = session();
    write(join(wt, "notes.md"), "user notes");
    write(join(wt, "notes2.md"), "more user notes");
    const mv = bash(s, "mv notes.md scratch.txt");
    const patch: Request = {
      sessionId: s.sessionId,
      harness: "claude",
      cwd: wt,
      tool: "apply_patch",
      input: {
        command:
          "*** Begin Patch\n*** Update File: notes2.md\n*** Move to: moved2.txt\n*** End Patch",
      },
    };
    try {
      expect(s.review(mv, undefined, "PreToolUse").decision).toBe("approve");
      renameSync(join(wt, "notes.md"), join(wt, "scratch.txt"));
      s.record({ requestHash: hash(mv), event: "execution-result", status: "succeeded" });
      expect(rm(s, "rm scratch.txt").decision).not.toBe("approve");
      expect(s.review(patch, undefined, "PreToolUse").decision).toBe("approve");
      renameSync(join(wt, "notes2.md"), join(wt, "moved2.txt"));
      s.record({ requestHash: hash(patch), event: "execution-result", status: "succeeded" });
      expect(rm(s, "rm moved2.txt").decision).not.toBe("approve");
      // A session-created file moved by the session stays the session's.
      create(s, "own.txt");
      const own = bash(s, "mv own.txt own2.txt");
      expect(s.review(own, undefined, "PreToolUse").decision).toBe("approve");
      renameSync(join(wt, "own.txt"), join(wt, "own2.txt"));
      s.record({ requestHash: hash(own), event: "execution-result", status: "succeeded" });
      expect(rm(s, "rm own2.txt").decision).toBe("approve");
    } finally {
      cleanup("notes.md", "notes2.md", "scratch.txt", "moved2.txt", "own.txt", "own2.txt");
    }
  });

  test("worktree deletion the session cannot prove is classified, and follows the verdict", () => {
    const verdict = (r: Request, recoverable: boolean, confidence = 0.95) => ({
      requestHash: hash(r),
      category: "destructive" as const,
      confidence,
      recoverable,
    });
    for (const [recoverable, confidence, expected] of [
      [true, 0.95, "approve"],
      [false, 0.99, "human"],
      [true, 0.9, "human"],
    ] as const) {
      const s = session();
      const r = bash(s, "rm new.txt");
      expect(s.review(r, undefined, "PreToolUse")).toMatchObject({ classification: "requested" });
      expect(s.classify(verdict(r, recoverable, confidence)).decision).toBe(expected);
    }
    // Outside the worktree, and history or remote destruction inside it, stay with a person.
    for (const [command, cwd] of [
      ["rm a.txt", repo],
      ["git clean -fdx", wt],
      ["git branch -D withf", wt],
      ["git push --force origin feature", wt],
    ] as const) {
      const s = session();
      const r = bash(s, command, cwd);
      expect(s.review(r, undefined, "PreToolUse").tier).toBeUndefined();
      expect(evaluate(r, verdict(r, true, 0.99), profile).decision).toBe("human");
    }
  });

  /** Approves, runs and reports a Bash command whose effect `effect` performs. */
  function run(s: PolicySession, command: string, effect: () => void) {
    const r = bash(s, command);
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("approve");
    effect();
    s.record({ requestHash: hash(r), event: "execution-result", status: "succeeded" });
  }
  const user = (name: string) => join(wt, "user", name);
  const restore = (name: string, from: string) => {
    renameSync(join(wt, from), user(name));
  };

  test("a renamed user file is not the session's, whatever touches it next", () => {
    for (const [command, append] of [
      ["mv user/user1.md x.txt && touch x.txt", () => {}],
      ["mv user/user1.md x.txt; echo >> x.txt", () => appendFileSync(join(wt, "x.txt"), "\n")],
      ["mv user/user1.md x.txt && tee -a x.txt < /dev/null", () => {}],
    ] as const) {
      const s = session();
      run(s, command, () => {
        renameSync(user("user1.md"), join(wt, "x.txt"));
        append();
      });
      try {
        expect(rm(s, "rm x.txt").decision).not.toBe("approve");
      } finally {
        restore("user1.md", "x.txt");
      }
    }
  });

  test("a path stays the session's only while its stamp still matches", () => {
    const s = session();
    create(s, "g.txt");
    try {
      run(s, "mv user/user2.md g.txt", () => renameSync(user("user2.md"), join(wt, "g.txt")));
      expect(rm(s, "rm g.txt").decision).not.toBe("approve");
      run(s, "echo done >> g.txt", () => appendFileSync(join(wt, "g.txt"), "done\n"));
      expect(rm(s, "rm g.txt").decision).not.toBe("approve");
    } finally {
      restore("user2.md", "g.txt");
    }
    create(s, "f.txt");
    try {
      rmSync(join(wt, "f.txt"));
      write(join(wt, "f.txt"), "a person's replacement");
      run(s, "touch f.txt", () => {});
      expect(rm(s, "rm f.txt").decision).not.toBe("approve");
    } finally {
      cleanup("f.txt");
    }
  });

  test("a new file filled by anything but a known creating form is not the session's", () => {
    // gzip writes the user's notes into notes.md.gz, a file born after the approval.
    const s = session();
    run(s, "gzip user/user3.md && touch user/user3.md.gz", () => {
      write(user("user3.md.gz"), "compressed user notes");
      rmSync(user("user3.md"));
    });
    try {
      expect(rm(s, "rm user/user3.md.gz").decision).not.toBe("approve");
    } finally {
      write(user("user3.md"), "user notes user3.md");
      rmSync(user("user3.md.gz"), { force: true });
    }
    // git stash pop restores a user's stashed file as a new inode.
    const t = session();
    run(t, "git stash pop && touch stashed.txt", () => write(join(wt, "stashed.txt"), "stashed"));
    try {
      expect(rm(t, "rm stashed.txt").decision).not.toBe("approve");
    } finally {
      cleanup("stashed.txt");
    }
    // The known forms still count.
    const u = session();
    run(u, "echo hi > made2.txt && touch made3.txt", () => {
      write(join(wt, "made2.txt"), "hi\n");
      write(join(wt, "made3.txt"), "");
    });
    try {
      expect(rm(u, "rm made2.txt made3.txt").decision).toBe("approve");
    } finally {
      cleanup("made2.txt", "made3.txt");
    }
  });

  /** Reviews, runs and reports a command, whatever the decision, as the hooks would. */
  function attempt(s: PolicySession, command: string, effect: () => void) {
    const r = bash(s, command);
    s.review(r, undefined, "PreToolUse");
    effect();
    s.record({ requestHash: hash(r), event: "execution-result", status: "succeeded" });
  }

  test("every command in the script must be provably on the creation allowlist", () => {
    const make = () => write(join(wt, "st.txt"), "a user's stashed data");
    for (const command of [
      "echo $(git stash pop) && touch st.txt",
      "echo `git stash pop` && touch st.txt",
      "cat <(git stash pop) > st.txt",
      "bash -c 'git stash pop; touch st.txt'",
      "sh -c 'touch st.txt'",
      "env touch st.txt",
      "echo st.txt | xargs touch",
      "time touch st.txt",
      "nice touch st.txt",
      "command touch st.txt",
      "./touch st.txt",
      "/tmp/evil/touch st.txt",
      "touch -r user/user4.md st.txt",
      "X=1 touch st.txt",
      "touch $HOME/../st.txt",
    ]) {
      const s = session();
      attempt(s, command, make);
      try {
        expect(rm(s, "rm st.txt").decision, command).not.toBe("approve");
      } finally {
        cleanup("st.txt");
      }
    }
    // The plain forms, and a system path to them, still count.
    for (const command of ["touch st.txt", "/usr/bin/touch st.txt", "echo hi | tee -a st.txt"]) {
      const s = session();
      attempt(s, command, make);
      try {
        expect(rm(s, "rm st.txt").decision, command).toBe("approve");
      } finally {
        cleanup("st.txt");
      }
    }
  });

  test("mv and cp count only from a file the session owns when the hook runs", () => {
    // Ownership cannot chain through earlier commands in the same script.
    const s = session();
    attempt(
      s,
      "mv user/user4.md x4.txt && cp x4.txt y4.txt && mv y4.txt x4.txt && touch x4.txt",
      () => {
        renameSync(user("user4.md"), join(wt, "x4.txt"));
        write(join(wt, "y4.txt"), "user notes user4.md");
        renameSync(join(wt, "y4.txt"), join(wt, "x4.txt"));
      },
    );
    try {
      expect(rm(s, "rm x4.txt").decision).not.toBe("approve");
    } finally {
      cleanup("x4.txt", "y4.txt");
      write(user("user4.md"), "user notes user4.md");
    }
    // A copy of a user's file is not the session's.
    const t = session();
    attempt(t, "cp user/user5.md y.txt", () => write(join(wt, "y.txt"), "user notes user5.md"));
    try {
      expect(rm(t, "rm y.txt").decision).not.toBe("approve");
    } finally {
      cleanup("y.txt");
    }
    // From the session's own file, both still count, also via a system path.
    const u = session();
    create(u, "mine.txt");
    attempt(u, "cp mine.txt copy.txt", () => write(join(wt, "copy.txt"), "probe"));
    attempt(u, "/bin/mv mine.txt moved.txt", () =>
      renameSync(join(wt, "mine.txt"), join(wt, "moved.txt")),
    );
    try {
      expect(rm(u, "rm copy.txt moved.txt").decision).toBe("approve");
    } finally {
      cleanup("mine.txt", "copy.txt", "moved.txt");
    }
  });

  test("a leading = is never a plain operand: zsh expands =name to a command's path", () => {
    const s = session();
    create(s, "=mytool");
    try {
      expect(rm(s, "rm =mytool").decision).not.toBe("approve");
      expect(rm(s, "rm ./=mytool").decision).toBe("approve");
    } finally {
      cleanup("=mytool");
    }
    expect(decide("rm =node")).not.toBe("approve");
    expect(decide("git rm -f =node")).not.toBe("approve");
    expect(decide("rm ./=node")).toBe("approve");
    expect(decide("git rm -f ./=node")).toBe("approve");
    const c = session();
    expect(rm(c, "rm =git").tier).toBeUndefined(); // not a worktree deletion for the classifier
    expect(rm(c, "rm ./=git").tier).toBe("ambiguous");
  });

  test("worktree deletion is classified only when it is the script's whole effect", () => {
    const classified = (command: string, cwd = wt) => {
      const s = session();
      return s.review(bash(s, command, cwd), undefined, "PreToolUse").tier === "ambiguous";
    };
    expect(classified("rm new.txt")).toBe(true);
    expect(classified("ls && rm new.txt; echo done")).toBe(true);
    if (links) expect(classified(`cd ${wt} && rm new.txt`, repo)).toBe(true);
    const masked = [
      "rm new.txt && git push --force origin feature",
      "rm new.txt; git clean -fdx",
      "rm new.txt; git branch -D withf",
      "rm new.txt; npm publish",
      "rm new.txt; sudo true",
      "rm new.txt; az group delete --yes -n x",
      "rm new.txt; curl -X DELETE https://example.com/x",
      "rm new.txt; rm -rf ~/Documents",
      "rm new.txt; cat ~/.ssh/id_rsa",
      "rm new.txt > ~/.zshrc",
      "rm new.txt && git reset --hard HEAD~1",
      "cd dir; rm b.txt",
      "cd dir || rm new.txt",
    ];
    if (links) masked.push(`cd ${repo}; rm new.txt`);
    for (const command of masked) {
      expect(classified(command), command).toBe(false);
      const r = bash(session(), command);
      const verdict = {
        requestHash: hash(r),
        category: "destructive" as const,
        confidence: 0.99,
        recoverable: true,
      };
      expect(evaluate(r, verdict, profile).decision, command).not.toBe("approve");
    }
  });

  test("protected paths stay with a person", () => {
    const s = session();
    expect(rm(s, "rm .github/w.yml")).toMatchObject({ decision: "human", category: "sensitive" });
    expect(rm(s, "rm -rf .claude")).toMatchObject({ decision: "human", category: "sensitive" });
  });
});

describe("git rm", () => {
  test("plain git rm keeps relying on git's own safety check", () =>
    expect(decide("git rm new.txt")).toBe("approve"));
  test("git rm --force needs the same evidence as rm", () => {
    expect(decide("git rm -f a.txt")).toBe("approve");
    expect(decide("git rm -rf dir")).toBe("approve");
    expect(decide("git rm -rf mixed")).toBe("human");
    expect(decide("git rm -f new.txt")).toBe("human");
    expect(decide("git rm -f 'dir/*'")).toBe("human");
    expect(decide("git rm -f ':(glob)dir/*'")).toBe("human");
    expect(decide("git rm -f --pathspec-from-file=list a.txt")).toBe("human");
    expect(decide("git rm -f a.txt", repo)).toBe("human");
    scenario(
      () => write(join(wt, "a.txt"), "changed"),
      () => expect(decide("git rm -f a.txt")).toBe("human"),
    );
    scenario(
      () => rmSync(join(wt, "a.txt")),
      () => expect(decide("git rm -f a.txt")).toBe("approve"),
    );
  });
});

describe("git reset --hard, checkout and restore", () => {
  test("clean worktree: reset, checkout and restore lose nothing", () => {
    expect(decide("git reset --hard")).toBe("approve");
    expect(decide("git reset --hard HEAD")).toBe("approve");
    expect(decide("git reset -q --hard HEAD~1")).toBe("approve"); // dropped commit is on origin/main
    expect(decide("git reset --hard origin/main")).toBe("approve");
    expect(decide("git checkout -- .")).toBe("approve");
    expect(decide("git checkout .")).toBe("approve");
    expect(decide("git restore a.txt dir")).toBe("approve");
    expect(decide("git restore -SW -- a.txt")).toBe("approve");
  });

  test.each([
    "git reset --hard --recurse-submodules",
    "git reset --hard HEAD -- a.txt",
    "git reset --hard HEAD 'HEAD~1'",
    "git reset --hard nosuchref",
    "git clean -fdx",
    "git checkout HEAD~1 -- a.txt",
    "git checkout -f",
    "git checkout -- .github",
    "git restore --source=HEAD~1 a.txt",
    "git restore -s HEAD~1 a.txt",
    "git restore -p a.txt",
    "git restore missing.txt",
    "git restore '*.txt'",
    "A=1 git reset --hard",
    "git -C . reset --hard",
    "git status && git reset --hard",
    "bash -c 'git reset --hard'",
  ])("sends %s to a human", (command) => expect(decide(command)).toBe("human"));

  test("uncommitted changes keep reset, checkout and restore with a human", () => {
    scenario(
      () => write(join(wt, "a.txt"), "changed"),
      () => {
        expect(decide("git reset --hard")).toBe("human");
        expect(decide("git checkout -- .")).toBe("human");
        expect(decide("git checkout -- a.txt")).toBe("human");
        expect(decide("git restore a.txt")).toBe("human");
        expect(decide("git checkout -- dir")).toBe("approve"); // the change is elsewhere
      },
    );
    scenario(
      () => {
        write(join(wt, "a.txt"), "staged");
        git(wt, ["add", "a.txt"]);
      },
      () => {
        expect(decide("git reset --hard")).toBe("human");
        expect(decide("git restore -SW a.txt")).toBe("human");
        expect(decide("git checkout -- a.txt")).toBe("approve"); // index already matches
      },
    );
    scenario(
      () => rmSync(join(wt, "a.txt")),
      () => {
        expect(decide("git checkout -- a.txt")).toBe("approve");
        expect(decide("git restore a.txt")).toBe("approve");
        expect(decide("git reset --hard")).toBe("human");
      },
    );
  });

  test("a commit only on this branch keeps reset to an older commit with a human", () => {
    write(join(wt, "local.txt"), "local");
    git(wt, ["add", "local.txt"]);
    git(wt, ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "local"]);
    try {
      expect(decide("git reset --hard HEAD~1")).toBe("human");
      expect(decide("git reset --hard")).toBe("approve");
    } finally {
      git(wt, ["reset", "-q", "--hard", "HEAD~1"]);
    }
  });

  test("an untracked file where the target writes keeps reset with a human", () => {
    git(wt, ["reset", "-q", "--hard", "HEAD~1"]);
    try {
      write(join(wt, "two.txt"), "untracked in the way");
      expect(decide("git reset --hard origin/main")).toBe("human");
      rmSync(join(wt, "two.txt"));
      expect(decide("git reset --hard origin/main")).toBe("approve");
    } finally {
      git(wt, ["reset", "-q", "--hard", "origin/main"]);
    }
  });

  test("the main clone stays human", () => {
    expect(decide("git reset --hard", repo)).toBe("human");
    expect(decide("git checkout -- .", repo)).toBe("human");
  });

  test("evidence is read at decision time", () => {
    expect(decide("rm a.txt")).toBe("approve");
    scenario(
      () => write(join(wt, "a.txt"), "changed"),
      () => expect(decide("rm a.txt")).toBe("human"),
    );
    expect(decide("rm a.txt")).toBe("approve");
  });
});
