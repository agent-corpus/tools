import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { git } from "./evidence.js";

/** Git with replace refs ignored, so `refs/replace/*` cannot change what is read. */
const exact = (top: string, args: string[]) => git(top, ["--no-replace-objects", ...args]);

/** The raw bytes of a blob, with replace refs ignored and no filters applied. */
function blobBytes(top: string, oid: string): Buffer {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-C", top, "--no-replace-objects", "cat-file", "blob", oid],
    {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
    },
  );
}

/**
 * Whether the working file is the committed blob: the same bytes, or, when the blob has no CR,
 * the same bytes once the working file's CRLF line ends become LF (a `core.autocrlf` checkout).
 * No clean filter or `.gitattributes` setting is applied.
 */
export function sameContent(working: Buffer, blob: Buffer): boolean {
  if (working.equals(blob)) return true;
  if (blob.includes(0x0d)) return false;
  return Buffer.from(working.toString("latin1").replace(/\r\n/g, "\n"), "latin1").equals(blob);
}

/**
 * A script allowed to read a credential for one narrow job, such as posting a review as a GitHub
 * App. It is trusted only as committed on the default branch and only with the argument shapes
 * listed for it; anything else stays with a person.
 */
export interface CredentialHelper {
  /** Repository-relative path with `/` separators, such as `tools/review-bot.mjs`. */
  path: string;
  /**
   * Accepted argument lists after the script. Each token is a literal, a list of literal
   * alternatives, or a string with placeholders (`repos/<repo>/pulls/<int>/reviews`).
   */
  args: Array<Array<string | string[]>>;
  /**
   * Where the helper's checkout must come from: normalized `host/owner/` prefixes (or a whole
   * `host/owner/repo`) that `remote.origin.url` must match, such as `github.com/example-org/`.
   */
  remotes: string[];
}

export class HelperError extends Error {}

/** A remote prefix: a lowercase host, then at least an owner; a trailing `/` makes it a prefix. */
const REMOTE_PREFIX = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?(?:\/[a-z0-9][a-z0-9_.-]*)+\/?$/;

/**
 * `host/path` for an https, ssh or scp-style (`git@host:path`) URL, with the host and path in
 * lower case and any `.git` and trailing `/` removed. Anything else (a local path, `file:`) is
 * undefined: its content does not come from a hosted remote.
 */
export function normalizeRemote(url: string): string | undefined {
  let host: string;
  let path: string;
  const full = /^(?:https|ssh|git\+ssh):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::[0-9]{1,5})?\/(.+)$/i.exec(
    url,
  );
  const scp = /^(?:[^@/\s:]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(url);
  if (full?.[1] && full[2]) [host, path] = [full[1], full[2]];
  else if (scp?.[1] && scp[2] && !/^[A-Za-z]$/.test(scp[1])) [host, path] = [scp[1], scp[2]];
  else return undefined;
  path = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const segments = path.split("/");
  if (!segments.length || segments.some((s) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s)))
    return undefined;
  return `${host}/${path}`.toLowerCase();
}

function remoteMatches(remotes: string[], normalized: string): boolean {
  return remotes.some((prefix) =>
    prefix.endsWith("/") ? normalized.startsWith(prefix) : normalized === prefix,
  );
}

export const MAX_HELPERS = 20;
const MAX_SHAPES = 50;
const MAX_TOKENS = 40;
const MAX_WORD = 1024;

/** Placeholder values. Each is checked whole; none may contain whitespace. */
const PLACEHOLDERS: Record<string, (value: string) => boolean> = {
  // Each segment starts with a letter or digit, so neither is `.` or `..`.
  repo: (v) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v),
  int: (v) => /^[0-9]{1,12}$/.test(v),
  sha: (v) => /^[0-9a-f]{7,40}$/.test(v),
  word: (v) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v),
  url: (v) => /^https:\/\/github\.com\/[A-Za-z0-9_./#-]{1,300}$/.test(v),
  // No pattern characters, no tilde the shell expands, and no device file such as /dev/stdin. The caller also checks
  // where the file is and that it may be read.
  file: (v) =>
    v.length > 0 &&
    !/[*?[\]{}]/.test(v) &&
    // `~` only right after a letter or digit (a Windows short name such as RUNNER~1).
    !/(?:^|[^A-Za-z0-9])~/.test(v) &&
    !/^\/dev\//.test(v),
  // Any one argument; the caller refuses one the shell would expand.
  text: () => true,
  // A URL path and query: no `..` segment, no user info, fragment or whitespace.
  path: (v) => /^[A-Za-z0-9_./?=&%,:-]{1,400}$/.test(v) && !/(?:^|\/)\.\.(?:\/|$|\?)/.test(v),
};

type Part = { literal: string } | { placeholder: string };

function parts(token: string): Part[] {
  const out: Part[] = [];
  let rest = token;
  while (rest.length) {
    const open = rest.indexOf("<");
    const close = open < 0 ? -1 : rest.indexOf(">", open);
    const name = close < 0 ? undefined : rest.slice(open + 1, close);
    if (open < 0 || name === undefined || !(name in PLACEHOLDERS)) {
      if (open >= 0 && close >= 0) throw new HelperError(`unknown placeholder in ${token}`);
      out.push({ literal: rest });
      break;
    }
    if (open > 0) out.push({ literal: rest.slice(0, open) });
    out.push({ placeholder: name });
    rest = rest.slice(close + 1);
  }
  if (out.some((part, i) => i > 0 && "placeholder" in part && "placeholder" in (out[i - 1] ?? {})))
    throw new HelperError(`adjacent placeholders in ${token}`);
  if (out.some((p) => "placeholder" in p && p.placeholder === "text") && out.length > 1)
    throw new HelperError(`<text> must be a whole argument in ${token}`);
  return out;
}

/** Matches `word` against a token's parts; `files` collects the values of `<file>` placeholders. */
function matchParts(list: Part[], word: string, files: string[]): boolean {
  const [head, ...rest] = list;
  if (!head) return word.length === 0;
  if ("literal" in head)
    return (
      word.startsWith(head.literal) && matchParts(rest, word.slice(head.literal.length), files)
    );
  const check = PLACEHOLDERS[head.placeholder];
  if (!check) return false;
  const next = rest[0];
  // A placeholder ends at the end of the word or right before the next literal.
  for (let end = word.length; end >= 1; end--) {
    if (next && "literal" in next && !word.startsWith(next.literal, end)) continue;
    if (!next && end !== word.length) continue;
    const value = word.slice(0, end);
    if (!check(value)) continue;
    const found: string[] = [];
    if (matchParts(rest, word.slice(end), found)) {
      if (head.placeholder === "file") files.push(value);
      files.push(...found);
      return true;
    }
  }
  return false;
}

/** Whether `args` match a shape token for token (literals, alternatives, placeholders). */
export function matchArgs(shape: Array<string | string[]>, args: string[]): boolean {
  if (shape.length !== args.length || args.some((word) => word.length > MAX_WORD)) return false;
  return shape.every((token, i) => matchToken(token, args[i] ?? "", []));
}
/** Validates one argument shape (for profile keys that reuse the helper token syntax). */
export function checkShape(shape: unknown, where: string): Array<string | string[]> {
  if (!Array.isArray(shape) || shape.length === 0 || shape.length > MAX_TOKENS)
    throw new HelperError(`each shape in ${where} must list 1 to ${MAX_TOKENS} tokens`);
  for (const token of shape) {
    if (Array.isArray(token)) {
      if (
        token.length === 0 ||
        token.some((t) => typeof t !== "string" || t.length === 0 || t.length > 200)
      )
        throw new HelperError(`alternatives in ${where} must be non-empty strings`);
    } else if (typeof token !== "string" || token.length === 0 || token.length > 300)
      throw new HelperError(`a token in ${where} must be a non-empty string`);
    else parts(token);
  }
  return shape as Array<string | string[]>;
}

function matchToken(token: string | string[], word: string, files: string[]): boolean {
  if (Array.isArray(token)) return token.includes(word);
  return matchParts(parts(token), word, files);
}

/** Index of the first shape `args` matches, with the `<file>` values it named. */
export function matchShape(
  helper: CredentialHelper,
  args: string[],
): { index: number; files: string[] } | undefined {
  if (args.some((word) => word.length > MAX_WORD)) return undefined;
  for (const [index, shape] of helper.args.entries()) {
    if (shape.length !== args.length) continue;
    const files: string[] = [];
    if (shape.every((token, i) => matchToken(token, args[i] ?? "", files))) return { index, files };
  }
  return undefined;
}

/** Validates the profile's `credentialHelpers`. */
export function parseCredentialHelpers(raw: unknown): CredentialHelper[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_HELPERS)
    throw new HelperError(`credentialHelpers must list at most ${MAX_HELPERS} helpers`);
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new HelperError("each credential helper must be an object");
    const { path, args, remotes, ...extra } = entry as Record<string, unknown>;
    if (
      !Array.isArray(remotes) ||
      remotes.length === 0 ||
      remotes.length > 20 ||
      remotes.some((r) => typeof r !== "string" || r.length > 200 || !REMOTE_PREFIX.test(r))
    )
      throw new HelperError(
        "each credential helper needs remotes: lowercase host/owner/ prefixes such as github.com/org/",
      );
    if (Object.keys(extra).length)
      throw new HelperError(`unknown credential helper key: ${Object.keys(extra)[0]}`);
    if (
      typeof path !== "string" ||
      path.length > 300 ||
      !/^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    )
      throw new HelperError(
        "a credential helper path must be repository-relative, with / separators",
      );
    if (!Array.isArray(args) || args.length === 0 || args.length > MAX_SHAPES)
      throw new HelperError(
        `credential helper ${path} must list 1 to ${MAX_SHAPES} argument shapes`,
      );
    for (const shape of args) {
      if (!Array.isArray(shape) || shape.length === 0 || shape.length > MAX_TOKENS)
        throw new HelperError(`each argument shape of ${path} must list 1 to ${MAX_TOKENS} tokens`);
      for (const token of shape) {
        if (Array.isArray(token)) {
          if (
            token.length === 0 ||
            token.some((t) => typeof t !== "string" || t.length === 0 || t.length > 200)
          )
            throw new HelperError(`alternatives in ${path} must be non-empty strings`);
        } else if (typeof token !== "string" || token.length === 0 || token.length > 300)
          throw new HelperError(`a token in ${path} must be a non-empty string`);
        else parts(token);
      }
    }
    return { path, args: args as CredentialHelper["args"], remotes: remotes as string[] };
  });
}

/**
 * The default branch on `origin`, by full ref name only, so a tag or branch called `origin/HEAD`
 * cannot stand in for it: `refs/remotes/origin/HEAD` when it points into `refs/remotes/origin/`,
 * else `refs/remotes/origin/main`.
 */
function defaultRef(top: string): string | undefined {
  const candidates: string[] = [];
  try {
    const target = exact(top, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (/^refs\/remotes\/origin\/[^\s]+$/.test(target) && target !== "refs/remotes/origin/HEAD")
      candidates.push(target);
  } catch {
    /* no origin/HEAD */
  }
  candidates.push("refs/remotes/origin/main");
  for (const ref of candidates)
    try {
      // `show-ref --verify` takes only a full name and never falls back to a shorter match.
      exact(top, ["show-ref", "--verify", "--quiet", ref]);
      return ref;
    } catch {
      /* try the next */
    }
  return undefined;
}

export type HelperMatch =
  | { kind: "none" }
  | { kind: "match"; helper: CredentialHelper; shape: number; files: string[] }
  | { kind: "refused"; reason: string };

/**
 * Whether `node <script> args...` runs a listed helper. `none`: the script is not a listed helper.
 * `refused`: it is at a listed helper's path but is changed, untracked, linked or run with other
 * arguments, so a person decides. `match`: the committed helper with an accepted shape.
 */
export function helperMatch(helpers: CredentialHelper[], cwd: string, argv: string[]): HelperMatch {
  const program = basename(argv[0] ?? "").toLowerCase();
  const script = argv[1];
  if (!helpers.length || (program !== "node" && program !== "node.exe") || script === undefined)
    return { kind: "none" };
  // Matched by file name first, then by where it really is, so any way of naming it is checked.
  const named = helpers.filter((h) => basename(script) === basename(h.path));
  if (!named.length) return { kind: "none" };
  const refused = (reason: string): HelperMatch => ({ kind: "refused", reason });
  let real: string;
  let top: string;
  try {
    const lexical = resolve(cwd, script);
    if (lstatSync(lexical).isSymbolicLink()) return refused("Credential helper is a symlink");
    real = realpathSync.native(lexical);
    if (!lstatSync(real).isFile()) return refused("Credential helper is not a regular file");
    top = realpathSync.native(git(dirname(real), ["rev-parse", "--show-toplevel"]));
  } catch {
    return refused("Credential helper is not inside a Git checkout");
  }
  const helper = named.find((h) => join(top, ...h.path.split("/")) === real);
  if (!helper) return refused("Credential helper is not at its listed path in the checkout");
  try {
    git(top, ["ls-files", "--error-unmatch", "--", helper.path]);
  } catch {
    return refused("Credential helper is not tracked");
  }
  // A clone or `git init` anywhere has its own origin; only a checkout whose origin is a listed
  // hosted remote, read as configured and as git resolves it, can vouch for the helper.
  let origin: string | undefined;
  try {
    const configured = git(top, ["config", "--get", "remote.origin.url"]);
    const resolved = git(top, ["remote", "get-url", "origin"]);
    let pushUrl = "";
    try {
      pushUrl = git(top, ["config", "--get", "remote.origin.pushurl"]);
    } catch {
      /* no push URL */
    }
    if (configured === resolved && !pushUrl) origin = normalizeRemote(configured);
  } catch {
    origin = undefined;
  }
  if (!origin || !remoteMatches(helper.remotes, origin))
    return refused("Credential helper's checkout does not come from a listed remote");
  const ref = defaultRef(top);
  if (!ref) return refused("Credential helper's default branch is unknown");
  let committed: Buffer;
  let current: Buffer;
  try {
    const oid = exact(top, ["rev-parse", "--verify", "--quiet", `${ref}:${helper.path}`]);
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error("not a blob id");
    committed = blobBytes(top, oid);
    current = readFileSync(real);
  } catch {
    return refused("Credential helper is not on the default branch");
  }
  if (!sameContent(current, committed))
    return refused("Credential helper differs from the default branch");
  const shape = matchShape(helper, argv.slice(2));
  if (!shape) return refused("Credential helper run with arguments outside its allowed shapes");
  return { kind: "match", helper, shape: shape.index, files: shape.files };
}

/**
 * Whether `script` (as run from `cwd`) is a regular, tracked file in a Git checkout whose bytes
 * equal its blob on origin's default branch; `"outside"` for a file in no checkout (installed
 * tools, temp scripts: judged as before). Anything unsure is false.
 */
export function committedScript(cwd: string, script: string): boolean | "outside" {
  // The policy manager's own CLI is judged by its own rules; a Windows path off Windows names no
  // file here.
  if (/policy-manager[\\/]dist[\\/]cli\.js$/i.test(script)) return "outside";
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(script)) return "outside";
  const lexical = resolve(cwd, script);
  // A file that does not exist yet (written earlier in the same script) counts where it would be.
  try {
    lstatSync(lexical);
  } catch {
    let dir = dirname(lexical);
    while (dir !== dirname(dir)) {
      try {
        lstatSync(dir);
        break;
      } catch {
        dir = dirname(dir);
      }
    }
    try {
      git(dir, ["rev-parse", "--show-toplevel"]);
      return false;
    } catch {
      return "outside";
    }
  }
  try {
    if (lstatSync(lexical).isSymbolicLink()) return false;
    const real = realpathSync.native(lexical);
    if (!lstatSync(real).isFile()) return false;
    let top: string;
    try {
      top = realpathSync.native(git(dirname(real), ["rev-parse", "--show-toplevel"]));
    } catch {
      return "outside";
    }
    const path = relative(top, real).split(sep).join("/");
    if (!path || path.startsWith("..")) return false;
    git(top, ["ls-files", "--error-unmatch", "--", path]);
    const ref = defaultRef(top);
    if (!ref) return false;
    const oid = exact(top, ["rev-parse", "--verify", "--quiet", `${ref}:${path}`]);
    if (!/^[0-9a-f]{40,64}$/.test(oid)) return false;
    return sameContent(readFileSync(real), blobBytes(top, oid));
  } catch {
    return false;
  }
}
