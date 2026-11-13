import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createdBySession } from "./created.js";
import { canonical, inside, isProtectedPath, protectedPath, sensitive } from "./evidence.js";
import { type Command, parseScript, type Word } from "./script.js";
import { parseShell } from "./shell.js";
import type { Request } from "./types.js";

/**
 * Deletions and resets that Git can undo: tracked content that is unmodified against HEAD, in a
 * linked worktree on a feature branch. Evidence is read from Git at decision time and never cached.
 * Any doubt returns false, which leaves the caller's human decision in place.
 */

const INERT = new Set(["cd", "pwd", "echo", "ls", "true"]);
const DESTRUCTIVE_GIT = new Set(["rm", "reset", "checkout", "restore"]);

/**
 * Evidence holds only when nothing else in the script can change the files first (`mv u t; rm t`).
 * The script may contain these deletions plus `cd` and a few inert commands, without redirections,
 * assignments, wrappers, variables or substitutions.
 */
/** Words of a plain simple command: no assignment, redirection, variable or substitution. */
function plainWords(command: Command | undefined): string[] | undefined {
  if (command?.kind !== "simple" || command.assigns.length || command.redirects.length)
    return undefined;
  const text = (word: Word) =>
    word.subs.length || !word.parts.every((part) => typeof part === "string")
      ? undefined
      : word.parts.join("");
  const words = command.argv.map(text);
  return words.every((word) => word !== undefined) ? (words as string[]) : undefined;
}

/**
 * The one directory a script deletes in when its whole effect is `rm` inside linked feature
 * worktrees, or undefined. The script may hold only `rm` and inert commands, with no redirection,
 * assignment, variable or substitution, and at most a leading `cd <dir>` whose list is joined by
 * `&&` alone: if the cd fails nothing else runs. Every `rm` must be a worktree deletion, so one
 * classifier verdict on the first cannot carry an unjudged later command.
 */
export function deletionScriptCwd(request: Request): string | undefined {
  const text = request.input.command ?? request.input.cmd;
  const script = typeof text === "string" ? parseScript(text) : undefined;
  if (!script?.items.length) return undefined;
  let cwd = request.cwd;
  const deletions: string[][] = [];
  for (const [i, item] of script.items.entries()) {
    if (item.background) return undefined;
    const nodes = [item.node.first, ...item.node.rest.map((r) => r.node)];
    for (const [j, node] of nodes.entries()) {
      if (node.negated || node.stages.length !== 1) return undefined;
      const [program, ...args] = plainWords(node.stages[0]) ?? [];
      if (program === "cd") {
        const only = i === 0 && j === 0 && script.items.length === 1;
        const anded = item.node.rest.every((r) => r.op === "&&");
        if (!only || !anded || args.length !== 1 || /^[~-]/.test(args[0] as string))
          return undefined;
        cwd = resolve(cwd, args[0] as string);
      } else if (program === "rm") deletions.push(args);
      else if (!program || !INERT.has(program)) return undefined;
    }
  }
  return deletions.length && deletions.every((args) => worktreeDeletion(cwd, args))
    ? cwd
    : undefined;
}

export function soleEffect(request: Request): boolean {
  const command = request.input.command ?? request.input.cmd;
  if (typeof command !== "string") return false;
  const pipelines = parseShell(command);
  if (!pipelines) return false;
  return pipelines.every(
    (stages) =>
      stages.length === 1 &&
      stages.every(
        (c) =>
          !c.env.length &&
          !c.redirects.length &&
          !c.subs.length &&
          c.stdin === undefined &&
          (INERT.has(c.argv[0] ?? "") ||
            c.argv[0] === "rm" ||
            (c.argv[0] === "git" && DESTRUCTIVE_GIT.has(c.argv[1] ?? ""))),
      ),
  );
}

/** Like evidence.git, with room for whole-repository listings. */
function git(cwd: string, args: string[], raw = false): string {
  const out = execFileSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
  // Porcelain status starts with a meaningful space (` M`), so -z output is never trimmed.
  return raw ? out : out.trim();
}

interface Worktree {
  root: string;
}

/** The linked worktree on a feature branch that contains `dir`, or undefined. */
function featureWorktree(dir: string): Worktree | undefined {
  const root = canonical(git(dir, ["rev-parse", "--show-toplevel"]));
  const gitDir = canonical(git(dir, ["rev-parse", "--absolute-git-dir"]));
  const common = canonical(resolve(dir, git(dir, ["rev-parse", "--git-common-dir"])));
  const branch = git(dir, ["branch", "--show-current"]);
  if (gitDir === common || !branch || /^(?:main|master)$/.test(branch)) return undefined;
  let fallback = "";
  try {
    fallback = git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  } catch {
    /* no remote default recorded */
  }
  if (fallback && fallback.replace(/^origin\//, "") === branch) return undefined;
  return { root };
}

interface Entry {
  xy: string;
  path: string;
}

function status(root: string, paths: string[], untracked: boolean): Entry[] {
  const out = git(
    root,
    [
      "--literal-pathspecs",
      "status",
      "--porcelain=v1",
      "-z",
      "--ignore-submodules=none",
      untracked ? "--untracked-files=all" : "--untracked-files=no",
      ...(untracked ? ["--ignored=matching"] : []),
      "--",
      ...paths,
    ],
    true,
  );
  const fields = out.split("\0").filter(Boolean);
  const entries: Entry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    const xy = field.slice(0, 2);
    entries.push({ xy, path: field.slice(3) });
    // Renames and copies carry the original path in the next field.
    if (/[RC]/.test(xy)) i++;
  }
  return entries;
}

/** Index flags that hide modifications from status: assume-unchanged, skip-worktree, unmerged. */
function hiddenFlags(root: string, paths: string[]): boolean {
  const flags = git(root, ["--literal-pathspecs", "ls-files", "-v", "-z", "--", ...paths]);
  return flags.split("\0").some((line) => line && (/^[a-z]/.test(line) || /^[SM] /.test(line)));
}

/** Hidden flags, or a submodule anywhere under the paths. */
function hiddenState(root: string, paths: string[]): boolean {
  if (hiddenFlags(root, paths)) return true;
  const stage = git(root, ["--literal-pathspecs", "ls-files", "-s", "-z", "--", ...paths]);
  if (stage.split("\0").some((line) => line.startsWith("160000 "))) return true;
  const head = git(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", "HEAD", "--", ...paths]);
  return head.split("\0").some((line) => line.startsWith("160000 "));
}

function tracked(root: string, path: string): boolean {
  return git(root, ["--literal-pathspecs", "ls-files", "-z", "--", path]) !== "";
}

// zsh expands a leading `~` and `=name` (the path of command `name`); `-` is an option and `:`
// a Git pathspec magic. `./=name` stays a plain file.
const PLAIN_OPERAND = /^[^~:=-]/;

/**
 * Resolves an operand to what the command removes, inside a feature worktree, or undefined.
 * Parent symlinks are followed; a final symlink is the link itself unless a trailing slash
 * follows it.
 */
function locate(
  cwd: string,
  operand: string,
): { root: string; rel: string; target: string; trailing: boolean } | undefined {
  if (!operand || !PLAIN_OPERAND.test(operand) || /[*?[\]\\]/.test(operand)) return undefined;
  const parts = operand.split("/");
  const trailing = parts.at(-1) === "";
  const segments = parts.filter((part, index) => part !== "" && !(index === 0 && part === "."));
  if (!segments.length || segments.some((part) => part === "." || part === "..")) return undefined;
  const lexical = resolve(cwd, operand);
  if (sensitive(lexical) || isProtectedPath(lexical)) return undefined;
  const target = trailing
    ? canonical(lexical)
    : join(canonical(dirname(lexical)), basename(lexical));
  if (sensitive(target) || isProtectedPath(target)) return undefined;
  const parent = canonical(dirname(target));
  const tree = featureWorktree(parent);
  if (!tree || !inside(tree.root, target) || target === tree.root) return undefined;
  const rel = relative(tree.root, target).split(sep).join("/");
  if (!rel || protectedPath(rel)) return undefined;
  return { root: tree.root, rel, target, trailing };
}

/** A deletion operand that names a credential or protected path, as written or resolved. */
export function deletesProtected(cwd: string, args: string[]): boolean {
  return args
    .filter((word) => !word.startsWith("-"))
    .some((word) => {
      try {
        const lexical = resolve(cwd, word);
        const real = canonical(lexical);
        return [lexical, real].some((path) => sensitive(path) || isProtectedPath(path));
      } catch {
        return false;
      }
    });
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Operands and -r of an `rm` with only -f, -r, -R, -d and -v, or undefined. */
function rmOperands(args: string[]): { operands: string[]; recursive: boolean } | undefined {
  const operands: string[] = [];
  let options = true;
  let recursive = false;
  for (const word of args) {
    if (options && word === "--") options = false;
    else if (options && word.startsWith("-")) {
      // BSD rm stops at the first operand, so a later `-x` is a file name the checks never saw.
      if (operands.length) return undefined;
      if (
        !/^-[frRdv]+$/.test(word) &&
        !["--force", "--recursive", "--dir", "--verbose"].includes(word)
      )
        return undefined;
      if (/^-[a-zA-Z]*[rR]/.test(word) || word === "--recursive") recursive = true;
    } else operands.push(word);
  }
  return operands.length ? { operands, recursive } : undefined;
}

/**
 * `rm` that removes only tracked content identical to HEAD (no untracked, ignored, modified or
 * staged path under any operand, no submodule): "tracked". Or, without -r, also untracked files
 * this session created and nothing has changed since: "session". Otherwise undefined.
 */
export function rmRecoverable(cwd: string, args: string[]): "tracked" | "session" | undefined {
  const parsed = rmOperands(args);
  if (!parsed) return undefined;
  let kind: "tracked" | "session" = "tracked";
  try {
    for (const operand of parsed.operands) {
      const found = locate(cwd, operand);
      if (!found || !exists(found.target)) return undefined;
      if (!tracked(found.root, found.rel)) {
        if (parsed.recursive || found.trailing || !createdBySession(found.target)) return undefined;
        kind = "session";
        continue;
      }
      if (status(found.root, [found.rel], true).length) return undefined;
      if (hiddenState(found.root, [found.rel])) return undefined;
    }
    return kind;
  } catch {
    return undefined;
  }
}

/**
 * An `rm` whose every operand is a plain path inside a linked feature worktree (not the worktree
 * itself, nothing protected): local file deletion the classifier may judge. Anything else that is
 * destructive stays a person's decision.
 */
export function worktreeDeletion(cwd: string, args: string[]): boolean {
  const parsed = rmOperands(args);
  try {
    return !!parsed && parsed.operands.every((operand) => locate(cwd, operand) !== undefined);
  } catch {
    return false;
  }
}

/**
 * `git rm -f`: the same evidence as rm, but a path already deleted from the working tree is fine,
 * since only the index changes.
 */
export function gitRmRecoverable(cwd: string, rest: string[]): boolean {
  const paths: string[] = [];
  let options = true;
  for (const word of rest) {
    if (options && word === "--") options = false;
    else if (options && word.startsWith("-")) {
      if (
        !/^-[frqn]+$/.test(word) &&
        !["--force", "--quiet", "--cached", "--dry-run", "--ignore-unmatch"].includes(word)
      )
        return false;
    } else paths.push(word);
  }
  if (!paths.length) return false;
  try {
    for (const path of paths) {
      const found = locate(cwd, path);
      if (!found || !tracked(found.root, found.rel)) return false;
      if (status(found.root, [found.rel], true).some((e) => e.xy !== " D")) return false;
      if (hiddenState(found.root, [found.rel])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * `git checkout [--] <paths>` and `git restore [-W|-SW] <paths>`: the working tree loses nothing
 * when it already matches the source (index, or HEAD for --staged --worktree), or the file is only
 * missing from it.
 */
export function restoreRecoverable(cwd: string, paths: string[], fromHead: boolean): boolean {
  if (!paths.length) return false;
  try {
    for (const path of paths) {
      if (path === ".") {
        const here = canonical(cwd);
        const tree = featureWorktree(here);
        if (!tree) return false;
        const rel = relative(tree.root, here).split(sep).join("/");
        if (protectedPath(rel) || sensitive(here) || !check(tree.root, rel || ".", fromHead))
          return false;
        continue;
      }
      const found = locate(cwd, path);
      if (!found || !check(found.root, found.rel, fromHead)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function check(root: string, rel: string, fromHead: boolean): boolean {
  if (!tracked(root, rel)) return false;
  const allowed = (xy: string) => (fromHead ? xy === " D" : xy[1] === " " || xy[1] === "D");
  if (!status(root, [rel], false).every((e) => allowed(e.xy) && !e.xy.includes("U"))) return false;
  // Without --recurse-submodules these leave a submodule's own files alone.
  return !hiddenFlags(root, [rel]);
}

const REVISION = /^[A-Za-z0-9][A-Za-z0-9/_.~^-]*$/;

/**
 * `git reset --hard [<commit>]` with no uncommitted tracked change, every commit it drops from the
 * branch still on a remote-tracking ref, and no untracked or ignored file where the target writes.
 */
export function resetRecoverable(cwd: string, target = "HEAD"): boolean {
  if (!REVISION.test(target)) return false;
  try {
    const tree = featureWorktree(canonical(cwd));
    if (!tree) return false;
    const { root } = tree;
    if (status(root, [], false).length || hiddenFlags(root, [])) return false;
    const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`]);
    if (git(root, ["rev-list", "--count", "HEAD", "--not", commit, "--remotes"]) !== "0")
      return false;
    const written = git(root, ["diff", "--name-only", "--no-renames", "-z", "HEAD", commit])
      .split("\0")
      .filter(Boolean);
    if (!written.length) return true;
    if (written.some((path) => protectedPath(path))) return false;
    const loose = status(root, [], true).map((e) => e.path.replace(/\/$/, ""));
    return !written.some((path) =>
      loose.some((u) => path === u || path.startsWith(`${u}/`) || u.startsWith(`${path}/`)),
    );
  } catch {
    return false;
  }
}
