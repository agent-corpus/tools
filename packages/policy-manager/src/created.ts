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

export const pathKey = (path: string) => createHash("sha256").update(path).digest("hex");

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
  const recorded = current?.get(pathKey(path));
  const now = recorded && stamp(path);
  return (
    !!recorded &&
    !!now &&
    now.dev === recorded.dev &&
    now.ino === recorded.ino &&
    now.size === recorded.size &&
    now.mtimeMs === recorded.mtimeMs
  );
}

const WRITE_TOOLS = new Set(["Write", "create", "write_file", "Edit", "edit"]);

/**
 * Paths an approved request may create or rewrite: those that do not exist yet, or that this
 * session created before (so its own later edits keep them its own). Best effort; a path it misses
 * only means a later deletion is classified instead of approved.
 */
export function creationTargets(request: Request, created: CreatedFiles): string[] {
  const input = request.input;
  const found: string[] = [];
  const add = (cwd: string, path: string) => {
    const at = located(cwd, path);
    if (at) found.push(at);
  };
  if (WRITE_TOOLS.has(request.tool)) {
    const file = input.file_path ?? input.path;
    if (typeof file === "string") add(request.cwd, file);
  } else if (request.tool === "apply_patch" && typeof input.command === "string") {
    for (const line of input.command.split("\n"))
      for (const prefix of ["*** Add File: ", "*** Update File: ", "*** Move to: "])
        if (line.startsWith(prefix)) add(request.cwd, line.slice(prefix.length));
  } else {
    const command = input.command ?? input.cmd;
    const pipelines = typeof command === "string" ? parseShell(command) : undefined;
    let cwd = request.cwd;
    for (const stages of pipelines ?? [])
      for (const { argv, redirects } of stages) {
        const [program, ...args] = argv;
        if (program === "cd" && args.length === 1) {
          cwd = resolve(cwd, args[0] as string);
          continue;
        }
        for (const r of redirects)
          if ((r.op === ">" || r.op === ">>") && r.target !== "/dev/null") add(cwd, r.target);
        const words = args.filter((word) => !word.startsWith("-"));
        if (program === "touch" || program === "tee") for (const word of words) add(cwd, word);
        if ((program === "cp" || program === "mv") && words.length >= 2)
          add(cwd, words.at(-1) as string);
      }
  }
  return [...new Set(found)].filter((path) => !exists(path) || created.has(pathKey(path)));
}
