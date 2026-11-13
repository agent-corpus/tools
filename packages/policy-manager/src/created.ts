import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonical } from "./evidence.js";
import { parseShell } from "./shell.js";
import type { Request } from "./types.js";

/**
 * Files this session created, keyed by a hash of the path with parent symlinks resolved, with the
 * file's identity after the creating tool ran. Held in the session only, never shared or cached.
 */
export interface Stamp {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}
export type CreatedFiles = Map<string, Stamp>;

/**
 * A path an approved request may create or rewrite. `prior` is the identity that may carry over:
 * the session's own file being edited in place, or its own file being moved there. Any other file
 * found there afterwards must be a new inode.
 */
export interface Target {
  path: string;
  prior?: Stamp;
}

export const pathKey = (path: string) => createHash("sha256").update(path).digest("hex");

/** Coarse filesystem clocks can stamp a new file slightly before the approval was given. */
const BIRTH_SLACK_MS = 100;

/** `path` with its parent symlinks resolved; the last component stays as written. */
export function located(cwd: string, path: string): string | undefined {
  try {
    const lexical = resolve(cwd, path);
    return join(canonical(dirname(lexical)), basename(lexical));
  } catch {
    return undefined;
  }
}

/** Identity of a regular file (not a symlink), or undefined. */
export function stamp(path: string): Stamp | undefined {
  try {
    const s = lstatSync(path);
    return s.isFile() ? { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

let current: CreatedFiles | undefined;

/** Runs `fn` with this session's created files visible to `createdBySession`. */
export function withCreated<T>(created: CreatedFiles | undefined, fn: () => T): T {
  const previous = current;
  current = created;
  try {
    return fn();
  } finally {
    current = previous;
  }
}

/** True when this session created `path` and nothing has replaced or changed it since. */
export function createdBySession(path: string): boolean {
  return current !== undefined && owns(current, path);
}

/** The session's recorded stamp for `path`, if the file there still matches it exactly. */
function owned(created: CreatedFiles, path: string | undefined): Stamp | undefined {
  const recorded = path === undefined ? undefined : created.get(pathKey(path));
  const now = recorded && stamp(path as string);
  return recorded &&
    now &&
    now.dev === recorded.dev &&
    now.ino === recorded.ino &&
    now.size === recorded.size &&
    now.mtimeMs === recorded.mtimeMs
    ? recorded
    : undefined;
}

function owns(created: CreatedFiles, path: string | undefined): boolean {
  return owned(created, path) !== undefined;
}

const WRITE_TOOLS = new Set(["Write", "create", "write_file", "Edit", "edit"]);
/**
 * The allowlist for shell scripts that record creations. A new inode proves nothing about its
 * content (`gzip notes.md && touch notes.md.gz`, `git stash pop && touch x`), so every simple
 * command must be one of these, in the form the checks below accept, or nothing is recorded.
 */
const CREATING = new Set(["touch", "tee", "cp", "mv", "cd", "pwd", "echo", "printf", "ls", "true"]);
/** Absolute directories whose `touch`, `cp`, ... are the system tools, not a lookalike script. */
const SYSTEM_BIN = /^\/(?:usr\/(?:local\/)?)?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/;

/**
 * A path word the shell passes through unchanged. A leading `~` or `=` (zsh's command path) and a
 * `$`, glob or brace anywhere could expand to something else, so such a word is unprovable.
 */
function literal(word: string): boolean {
  return word.length > 0 && !/^[~=]/.test(word) && !/[$*?[\]{}]/.test(word);
}

/** The allowlisted program `word` names, or undefined (a relative path may be any script). */
function program(word: string | undefined): string | undefined {
  if (!word || (word.includes("/") && !SYSTEM_BIN.test(word))) return undefined;
  const name = basename(word);
  return CREATING.has(name) ? name : undefined;
}

/**
 * Creation targets of a plain script, or undefined when any command is not provably on the
 * allowlist. A substitution, process substitution, heredoc, input or descriptor redirect,
 * expandable path word, assignment, wrapper (`env`, `xargs`, `time`, `nice`, `command`), nested
 * shell or unknown option makes the whole script record
 * nothing; so does `mv` or `cp` from a file the session does not own when the hook runs (an
 * earlier command in the same script cannot confer ownership).
 */
function shellTargets(
  pipelines: NonNullable<ReturnType<typeof parseShell>>,
  start: string,
  created: CreatedFiles,
): Target[] | undefined {
  const found: Target[] = [];
  let cwd = start;
  const add = (path: string, prior?: Stamp) => {
    const at = literal(path) ? located(cwd, path) : undefined;
    if (!at) return false;
    found.push({ path: at, ...(prior ? { prior } : {}) });
    return true;
  };
  for (const stages of pipelines)
    for (const c of stages) {
      // parseShell already refuses heredocs and here-strings, so `subs` and `env` are what remain.
      if (c.subs.length || c.env.length) return undefined;
      const name = program(c.argv[0]);
      if (!name) return undefined;
      const args = c.argv.slice(1);
      const flags = args.filter((word) => word.startsWith("-"));
      const words = args.filter((word) => !word.startsWith("-"));
      // Only output redirects to the script's own targets: `tee y < notes.md` reads a user's file,
      // and `<`, `>&` and the like may carry content the session did not write.
      for (const r of c.redirects) {
        if (r.op !== ">" && r.op !== ">>") return undefined;
        if (r.target !== "/dev/null" && !add(r.target)) return undefined;
      }
      if (name === "cd") {
        if (args.length !== 1 || flags.length || !literal(args[0] as string)) return undefined;
        cwd = resolve(cwd, args[0] as string);
      } else if (name === "touch") {
        if (flags.length) return undefined;
        for (const word of words) if (!add(word)) return undefined;
      } else if (name === "tee") {
        if (flags.some((flag) => flag !== "-a")) return undefined;
        for (const word of words) if (!add(word)) return undefined;
      } else if (name === "cp" || name === "mv") {
        if (flags.some((flag) => flag !== "-f" && flag !== "-v") || words.length !== 2)
          return undefined;
        // Only from a file the session owns now: `mv` keeps its inode, `cp` copies its content.
        const from = words[0] as string;
        const source = literal(from) ? owned(created, located(cwd, from)) : undefined;
        if (!source || !add(words[1] as string, name === "mv" ? source : undefined))
          return undefined;
      }
    }
  return found;
}

/**
 * Paths an approved request may create or rewrite: those that do not exist yet, or that are still
 * the session's own file. Best effort; a path it misses only means a later deletion is classified
 * instead of approved.
 */
export function creationTargets(request: Request, created: CreatedFiles): Target[] {
  const input = request.input;
  const found: Target[] = [];
  const add = (cwd: string, path: string, prior?: Stamp) => {
    const at = located(cwd, path);
    if (at) found.push({ path: at, ...(prior ? { prior } : {}) });
  };
  if (WRITE_TOOLS.has(request.tool)) {
    const file = input.file_path ?? input.path;
    if (typeof file === "string") add(request.cwd, file);
  } else if (request.tool === "apply_patch" && typeof input.command === "string") {
    let source: string | undefined;
    for (const line of input.command.split("\n")) {
      if (line.startsWith("*** Add File: ")) add(request.cwd, line.slice(14));
      if (line.startsWith("*** Update File: ")) {
        source = located(request.cwd, line.slice(17));
        if (source) found.push({ path: source });
      }
      // A move keeps the source's content, so the target is the session's only if the source was.
      const moved = owned(created, source);
      if (line.startsWith("*** Move to: ") && moved) add(request.cwd, line.slice(13), moved);
    }
  } else {
    const command = input.command ?? input.cmd;
    const pipelines = typeof command === "string" ? parseShell(command) : undefined;
    const targets = pipelines && shellTargets(pipelines, request.cwd, created);
    if (!targets) return [];
    found.push(...targets);
  }
  const unique = new Map<string, Target>();
  for (const target of found) {
    // Only a path that is new, or still exactly the session's file, can become or stay its own.
    const own = owned(created, target.path);
    if (exists(target.path) && !own) continue;
    const prior = target.prior ?? own ?? unique.get(target.path)?.prior;
    unique.set(target.path, { path: target.path, ...(prior ? { prior } : {}) });
  }
  return [...unique.values()];
}

/**
 * The session's stamp for a target after its tool ran, or undefined. A file is the session's only
 * if it is the prior inode (its own file, edited or moved there) or a new inode born after the
 * approval. A rename keeps the birth time, so `mv notes.md x && touch x` does not qualify. Without
 * a birth time from the platform, nothing new is recorded.
 */
export function settle(target: Target, approvedAt: number): Stamp | undefined {
  let s: ReturnType<typeof lstatSync>;
  try {
    s = lstatSync(target.path);
  } catch {
    return undefined;
  }
  if (!s.isFile()) return undefined;
  const now = { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
  if (target.prior && now.dev === target.prior.dev && now.ino === target.prior.ino) return now;
  return s.birthtimeMs > 0 && s.birthtimeMs >= approvedAt - BIRTH_SLACK_MS ? now : undefined;
}
