import { execFileSync } from "node:child_process";
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { parseShell } from "./shell.js";

/** Path separators: `/`, and `\` only on Windows; on POSIX `\` is a file-name character. */
const SEPARATOR = process.platform === "win32" ? /[\\/]/ : /\//;
const SEPARATORS = process.platform === "win32" ? /[\\/]+/ : /\/+/;

/**
 * The working directory after a `cd` whose destination is unknown. It cannot exist (a NUL byte),
 * and a relative path against it never resolves, so nothing relative is approved there.
 */
export const UNKNOWN_CWD = resolve("/", "\u0000unknown-directory");

/**
 * A shell word as an absolute path, with a leading `~` expanded as the shell does. `~user`, `~+`,
 * `~-` and zsh's `=name` (the path of an executable) cannot be resolved here and throw.
 *
 * `..` is applied the way the kernel does, to the directory a symlink points to: `link/../x` names
 * `x` beside the link's target, not beside the link.
 */
export function resolveWord(cwd: string, word: string): string {
  let base: string;
  let rest: string;
  if (word === "~" || (SEPARATOR.test(word.slice(1, 2)) && word.startsWith("~"))) {
    base = homedir();
    rest = word.slice(2);
  } else if (word.startsWith("~") || word.startsWith("=")) {
    throw new Error("Unresolvable expansion");
  } else if (isAbsolute(word)) {
    const root = parse(word).root;
    // On Windows a drive-less root (`/etc`) is on the cwd's drive, not the process's.
    base = resolve(cwd, root);
    rest = word.slice(root.length);
  } else {
    if (cwd === UNKNOWN_CWD) throw new Error("Unknown working directory");
    base = cwd;
    rest = word;
  }
  const parts = rest.split(SEPARATORS);
  if (!parts.includes("..")) return resolve(base, rest);
  let current = resolve(base);
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    current = part === ".." ? dirname(canonical(current)) : join(current, part);
  }
  return current;
}

/**
 * Git answers memoized for the length of one decision (`withEvidence`): a script that names the
 * same checkout many times asks Git once per question. Outside a decision nothing is cached, so a
 * long-running service never reuses an answer across requests.
 */
let gitMemo: Map<string, { out?: string; error?: unknown }> | undefined;
let gitDepth = 0;
/** `canonical` answers for the length of one decision, like `gitMemo`. */
let realMemo: Map<string, { out?: string; error?: unknown }> | undefined;
let evidenceScopes = 0;
/** The current decision's scope, or undefined outside one: memos must not outlive it. */
export function evidenceScope(): number | undefined {
  return gitDepth > 0 ? evidenceScopes : undefined;
}
export function withEvidence<T>(run: () => T): T {
  if (gitDepth++ === 0) {
    evidenceScopes++;
    gitMemo = new Map();
    realMemo = new Map();
  }
  try {
    return run();
  } finally {
    if (--gitDepth === 0) {
      gitMemo = undefined;
      realMemo = undefined;
    }
  }
}

export function git(cwd: string, args: string[]): string {
  if (!gitMemo) return gitOnce(cwd, args);
  const key = JSON.stringify([cwd, args]);
  let hit = gitMemo.get(key);
  if (!hit) {
    try {
      hit = { out: gitOnce(cwd, args) };
    } catch (error) {
      hit = { error };
    }
    gitMemo.set(key, hit);
  }
  if ("error" in hit) throw hit.error;
  return hit.out as string;
}

function gitOnce(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  }).trim();
}
export function canonical(path: string, links = 0): string {
  if (!realMemo || links) return canonicalOnce(path, links);
  let hit = realMemo.get(path);
  if (!hit) {
    try {
      hit = { out: canonicalOnce(path, 0) };
    } catch (error) {
      hit = { error };
    }
    if (realMemo.size < 20_000) realMemo.set(path, hit);
  }
  if ("error" in hit) throw hit.error;
  return hit.out as string;
}

function canonicalOnce(path: string, links: number): string {
  // Native resolution expands Windows 8.3 aliases as well as symlinks, so
  // paths supplied by Node and Git describe the same repository boundaries.
  if (existsSync(path)) return realpathSync.native(path);
  // A dangling symlink is followed: writing through it creates its target.
  let link: string | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path);
  } catch {
    /* missing */
  }
  if (link !== undefined) {
    if (links >= 40) throw new Error("Too many symbolic links");
    return canonical(resolve(dirname(path), link), links + 1);
  }
  const parent = dirname(path);
  if (parent === path) throw new Error("Cannot resolve path");
  return resolve(canonical(parent, links), basename(path));
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
const CREDENTIAL_CONFIG_DIRS =
  /(?:^|[\\/])\.config[\\/](?:gh|gcloud|op|hub|curl|git|pip|yarn|npm)(?:[\\/]|$)/i;

/**
 * A file in a policy service session directory (`acp-<uid>-*`) other than its audit logs: the
 * session token authenticates grants, so it and everything beside it (socket, grants) is a secret.
 */
function stateSecret(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const at = parts.findIndex((part) => /^acp-(?:\d+|user)-/i.test(part));
  if (at < 0) return false;
  const rest = parts.slice(at + 1).filter(Boolean);
  return rest.length > 1 || (rest.length === 1 && !/^audit(?:\.\d+)?\.jsonl$/i.test(rest[0] ?? ""));
}

export function sensitive(path: string): boolean {
  return (
    stateSecret(path) ||
    CREDENTIAL_CONFIG_DIRS.test(path) ||
    path
      .split(/[\\/]/)
      .some((part) =>
        /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gcloud|\.docker|\.gnupg|\.password-store|\.git-credentials|\.vault-token|\.pgpass|\.my\.cnf|\.pypirc|\.npmrc|\.netrc|\.kube|(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini|env|txt|xml|conf|cfg|properties))?|id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk|xmss)|client_secret.*\.json|\.curlrc|curlrc|\.wgetrc|\.gitconfig|\.yarnrc(?:\.yml)?|kubeconfig|terraform\.tfstate(?:\..*)?|.*\.(?:pem|key|pfx|p12|p8|jks|keystore|ppk))$/i.test(
          part,
        ),
      )
  );
}
/** Files in a Git directory that can hold credentials (a token in a remote URL or extra header). */
const GIT_SECRET = /^(?:config.*|\.?credentials?(?:\..*)?|.*\.(?:pem|key))$/i;
/**
 * Whether reading `path` could read a credential. A Git directory is one only for the files that
 * can hold one (`config`, `config.worktree`, credentials), or when read as a tree (`whole`) from the
 * directory itself, a linked worktree's or a submodule's: `HEAD`, `gitdir`, `commondir`, `locked`,
 * refs and logs carry none, and neither does a worktree's `.git` file. Writes keep `sensitive`.
 */
export function readSensitive(path: string, whole = false): boolean {
  if (!sensitive(path)) return false;
  // A pattern (a glob or brace expansion) can name any file there: judged the strict way.
  if (/[*?[{]/.test(path)) return true;
  const parts = path.split(/[\\/]/);
  const at = parts.findIndex((part) => part.toLowerCase() === ".git");
  if (at < 0) return true;
  const rest = parts.slice(at + 1).filter(Boolean);
  // Sensitive for another reason as well (a key file, `.ssh`, the policy state, `gh` config).
  const other = [...parts.slice(0, at), ...rest].join("/");
  if (sensitive(other) || rest.some((part) => part.toLowerCase() === ".git")) return true;
  if (rest.some((part) => GIT_SECRET.test(part))) return true;
  if (!whole) return false;
  return (
    rest.length === 0 ||
    (rest[0] === "worktrees" && rest.length <= 2) ||
    (rest[0] === "modules" && !rest.some((part) => /^(?:objects|refs|logs|hooks|info)$/.test(part)))
  );
}
const PROTECTED_NAME =
  /^(?:\.agent-config|\.local|\.codex|\.claude|\.agents|AGENTS\.md|CLAUDE\.md|\.github)$/i;
/**
 * Protected names that are ordinary code in a linked feature worktree: the repository's agent
 * instructions and shared agent configuration. Harness settings and hooks (`.claude`, `.codex`),
 * CI (`.github`) and `.local` stay protected there too.
 */
const WORKTREE_CODE_NAME = /^(?:\.agent-config|\.agents|AGENTS\.md|CLAUDE\.md)$/i;
/**
 * Whether a path names a protected file or directory at any depth. With `featureWorktree` (the
 * path is relative to a verified linked feature worktree) only names outside WORKTREE_CODE_NAME
 * count, so `.agent-config/x.md` is code there while `.agent-config/.claude/x` is not.
 */
export function protectedPath(path: string, featureWorktree = false): boolean {
  return path
    .split(/[\\/]/)
    .some(
      (part) => PROTECTED_NAME.test(part) && !(featureWorktree && WORKTREE_CODE_NAME.test(part)),
    );
}
/**
 * The top level of the linked worktree that contains `dir`, when it is on a feature branch: not
 * the main checkout, not detached, and not main, master or origin's default branch. When the
 * default branch is unknown (no `origin/HEAD`, and no main or master), it is not one.
 */
export function featureCheckout(dir: string): string | undefined {
  try {
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
    // With no origin default recorded, the default branch is known only by its usual names: a
    // repository with neither main nor master has an unknown default, and fails closed.
    if (!fallback) {
      const named = [
        "refs/heads/main",
        "refs/heads/master",
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
      ].some((ref) => {
        try {
          git(dir, ["rev-parse", "--verify", "--quiet", ref]);
          return true;
        } catch {
          return false;
        }
      });
      if (!named) return undefined;
    }
    return root;
  } catch {
    return undefined;
  }
}
/**
 * Protected names (.claude, .agent-config, AGENTS.md ...) guard a repository's own configuration,
 * so they are judged relative to the Git top level. A linked worktree that lives under
 * `<repo>/.claude/worktrees/<name>` is ordinary code, while `<worktree>/.claude/settings.json`
 * stays protected. In a linked feature worktree `.agent-config`, `.agents`, `AGENTS.md` and
 * `CLAUDE.md` are ordinary code too (WORKTREE_CODE_NAME); in the main checkout or on the default
 * branch they stay protected.
 */
export function isProtectedPath(path: string): boolean {
  try {
    let parent = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
    while (!existsSync(parent)) parent = dirname(parent);
    const root = canonical(git(parent, ["rev-parse", "--show-toplevel"]));
    const feature = featureCheckout(parent) === root;
    // A path in `.claude/worktrees/<name>/` whose worktree is gone (or not yet made) is judged
    // inside that worktree's own top level, as it would be while it exists; its default branch is
    // unknown, so the worktree-code names stay protected.
    const inside = /^\.claude\/worktrees\/[^/]+\/(.+)$/.exec(
      relative(root, canonical(path)).replace(/\\/g, "/"),
    )?.[1];
    if (inside !== undefined) return protectedPath(inside);
    if (protectedPath(relative(root, canonical(path)), feature)) return true;
    // A protected name that is a symlink (`.claude -> config`) vanishes once the path is resolved,
    // so also judge the path as written, relative to the checkout it lives in.
    const written = resolve(path);
    let ancestor = dirname(written);
    while (ancestor !== dirname(ancestor)) {
      if (existsSync(ancestor) && canonical(ancestor) === root)
        return protectedPath(relative(ancestor, written), feature);
      ancestor = dirname(ancestor);
    }
    return false;
  } catch {
    return protectedPath(path);
  }
}

/** The policy service's own session directories (audit log, token, socket) under the temp dir. */
export function policyState(path: string): boolean {
  return path.split(/[\\/]/).some((part) => /^acp-/i.test(part));
}

let temps: string[] | undefined;
/**
 * Canonical system temp roots. A root that is the filesystem root or contains the home directory
 * (a misconfigured TMPDIR) grants nothing.
 */
export function tempRoots(): string[] {
  if (temps) return temps;
  const candidates = [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/private/tmp"])];
  const roots = new Set<string>();
  let home: string | undefined;
  try {
    home = canonical(homedir());
  } catch {
    /* no home directory to protect */
  }
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
      const root = canonical(candidate);
      if (dirname(root) === root || (home && inside(root, home))) continue;
      roots.add(root);
    } catch {
      /* an unresolvable root grants nothing */
    }
  }
  temps = [...roots];
  return temps;
}

/**
 * A recoverable write in the system temp directory: strictly below a temp root once symlinks and
 * `..` are resolved, outside the policy service's own state, and not a hard link that could alias
 * a file elsewhere.
 */
export function tempWrite(lexical: string, path: string): boolean {
  if (policyState(lexical) || policyState(path)) return false;
  if (!tempRoots().some((root) => root !== path && inside(root, path))) return false;
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() && stat.nlink > 1) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  return true;
}

/** Whether a directory tree holds a Git repository; too large to inspect counts as yes. */
function holdsRepository(path: string): boolean {
  let budget = 5000;
  const pending = [path];
  while (pending.length) {
    const dir = pending.pop() as string;
    let entries: Dirent[];
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return true;
    }
    for (const entry of entries) {
      if (--budget < 0 || entry.name.toLowerCase() === ".git") return true;
      if (entry.isDirectory()) pending.push(resolve(dir, entry.name));
    }
  }
  return false;
}

/**
 * A deletion target that is disposable: strictly inside one of `roots` once symlinks and `..` are
 * resolved, not policy state, protected or credential paths, and not in or holding a Git
 * repository (unpushed work). A glob is allowed only in the last component, and then its
 * directory must itself be strictly inside a root.
 */
export function disposable(cwd: string, input: string, roots: string[], fill?: Fill): boolean {
  try {
    let target = input;
    if (/[*?[]/.test(input)) {
      const parts = input.split(SEPARATOR);
      const last = parts.pop() ?? "";
      if (!last || last.startsWith(".") || parts.some((part) => /[*?[]/.test(part))) return false;
      target = parts.join("/") || (parts.length ? "/" : ".");
    }
    const lexical = resolveWord(cwd, target);
    const path = canonical(lexical);
    if (
      fill?.script.tainted ||
      policyState(lexical) ||
      policyState(path) ||
      sensitive(lexical) ||
      sensitive(path) ||
      protectedPath(lexical) ||
      protectedPath(path) ||
      !roots.some((root) => root !== path && inside(root, path))
    )
      return false;
    let parent = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
    while (!existsSync(parent)) parent = dirname(parent);
    try {
      git(parent, ["rev-parse", "--show-toplevel"]);
      return false;
    } catch {
      /* not inside a repository */
    }
    if (holdsRepository(path)) return false;
    if (fill?.reorder) fill.script.approved = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Paths are resolved when the hook runs, before the script does. A command that can create a
 * symlink (a recursive copy, a move, an extract, an unknown program) may plant one anywhere, so
 * after it no temp write or scratch deletion in the same script is approved.
 */
export interface Fill {
  /** Shared by the whole script, nested `bash -c` scripts included. */
  script: {
    /** An earlier command may have created a symlink. */
    tainted: boolean;
    /** A temp path was approved where a later command can run first. */
    approved: boolean;
    /** Background jobs started so far; one may outlive the loop or pipeline that started it. */
    jobs: number;
    /** An earlier command may have written or changed a file (anything but a plain reader). */
    wrote?: boolean;
  };
  /** In a loop, a pipeline or a background job a later command can run first. */
  reorder: boolean;
}

export const OUTSIDE_REPOSITORY = "Cannot verify repository and path evidence";

/** A write target the engine refused only for its protected name, as written and resolved. */
export interface ProtectedWrite {
  word: string;
  lexical: string;
  path: string;
  /** Named by `mkdir`: a directory, not a file. */
  directory: boolean;
}
let noting: { writes: ProtectedWrite[]; links: boolean } | undefined;
export const NOTED_WRITE = "Protected write noted for a session approval";

/**
 * Runs `run` while each write target refused only because it names a protected path (not a
 * credential path) is noted and allowed, so the rest of the request is judged as if a person had
 * approved those writes. Session grants use it to read what a protected-path request writes.
 * `links` reports a command that can create or replace a symlink anywhere in a script: the
 * noted paths are read before the script runs, so they no longer say where its writes land.
 */
export function noteProtectedWrites<T>(run: () => T): {
  value: T;
  writes: ProtectedWrite[];
  links: boolean;
} {
  const previous = noting;
  const state = { writes: [] as ProtectedWrite[], links: false };
  noting = state;
  try {
    const value = run();
    return { value, writes: state.writes, links: state.links };
  } finally {
    noting = previous;
  }
}

/** While noting, records that a command in the script can create or replace a symlink. */
export function noteLinkRisk(): void {
  if (noting) noting.links = true;
}

/**
 * While noting, records a protected, non-credential write target and reports it as allowed. It
 * returns before the linked-worktree check on purpose: a person's yes for a protected file covers
 * it in whichever checkout it is, the main one included, as it always has for a Write.
 */
export function notedProtectedWrite(
  word: string,
  lexical: string,
  path: string,
  directory = false,
): boolean {
  if (!noting || sensitive(lexical) || sensitive(path)) return false;
  if (!isProtectedPath(path) && !isProtectedPath(lexical)) return false;
  noting.writes.push({ word, lexical, path, directory });
  return true;
}

export const MEMORY_WRITE = "Write to Claude Code's auto-memory";
/**
 * Whether a write target is a Markdown file directly in a Claude Code auto-memory directory,
 * `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<project>/memory/<name>.md` (`MEMORY.md` included),
 * which Claude Code itself writes without asking. The path as written has no `..` segment, and
 * resolves to that same place with no symlink on the way: neither the file nor any directory.
 */
export function claudeMemoryFile(input: string, lexical: string): boolean {
  try {
    if (input.split(/[\\/]/).includes("..")) return false;
    const config = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    const rel = relative(config, resolve(lexical)).split(sep);
    if (rel.length !== 4 || rel[0] !== "projects" || rel[2] !== "memory") return false;
    const [, project = "", , name = ""] = rel;
    if (!project || project.startsWith(".") || !/^[^/\\]+\.md$/.test(name)) return false;
    // No symlink anywhere: the configuration directory and every step below it are what they say.
    const memory = join(config, "projects", project, "memory");
    if (canonical(memory) !== join(canonical(config), "projects", project, "memory")) return false;
    // A directory not created yet is fine (Claude Code creates it); one that exists is no link.
    for (const dir of [join(config, "projects"), join(config, "projects", project), memory])
      if (isLink(dir)) return false;
    const file = join(memory, name);
    if (existsSync(file) || isLink(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.nlink > 1) return false;
    }
    return true;
  } catch {
    return false;
  }
}
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function pathEvidence(
  cwd: string,
  input: string,
  write: boolean,
): { allowed: boolean; category: "code-read" | "worktree-write" | "sensitive"; reason: string } {
  try {
    const lexical = resolveWord(cwd, input);
    const path = canonical(lexical);
    if (write && notedProtectedWrite(input, lexical, path))
      return { allowed: true, category: "worktree-write", reason: NOTED_WRITE };
    if (write && claudeMemoryFile(input, lexical))
      return { allowed: true, category: "worktree-write", reason: MEMORY_WRITE };
    if (
      sensitive(path) ||
      sensitive(lexical) ||
      (write && (isProtectedPath(path) || isProtectedPath(lexical)))
    )
      return {
        allowed: false,
        category: "sensitive",
        reason: "Protected path requires human approval",
      };
    let parent = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
    while (!existsSync(parent)) parent = dirname(parent);
    const root = canonical(git(parent, ["rev-parse", "--show-toplevel"]));
    if (!inside(root, path)) throw new Error("Outside repository");
    if (!write)
      return { allowed: true, category: "code-read", reason: "Read within a Git repository" };
    const gitDir = canonical(git(parent, ["rev-parse", "--absolute-git-dir"]));
    const common = canonical(resolve(parent, git(parent, ["rev-parse", "--git-common-dir"])));
    const branch = git(parent, ["branch", "--show-current"]);
    if (gitDir === common || !branch || /^(?:main|master)$/.test(branch))
      return {
        allowed: false,
        category: "worktree-write",
        reason: "Write requires a linked worktree on a feature branch",
      };
    return {
      allowed: true,
      category: "worktree-write",
      reason: "Write within a linked feature worktree",
    };
  } catch {
    return {
      allowed: false,
      category: write ? "worktree-write" : "code-read",
      reason: OUTSIDE_REPOSITORY,
    };
  }
}

export function branchEvidence(cwd: string, branch: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(branch)) return "Cannot verify branch name";
  try {
    const commit = git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    const upstream = git(cwd, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`]);
    const remotes = git(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes/"])
      .split("\n")
      .filter(Boolean);
    const unique = git(cwd, ["rev-list", "--count", commit, "--not", ...remotes]);
    return `Local branch deletion requires human approval; upstream=${upstream ? "present" : "absent"}; commits absent from fetched remote refs=${unique}; remote state may be stale`;
  } catch {
    return "Local branch deletion requires human approval; branch reachability could not be verified";
  }
}

/**
 * The top level of the verified linked feature worktree that `GIT_DIR=<value>` (its own git
 * directory, `.git/worktrees/<name>`, or the `.git` file it has) or `GIT_WORK_TREE=<value>` (its
 * top level) names, as a literal path. A main checkout, another repository, or anything unsure
 * is undefined.
 */
export function featureGitTop(name: string, value: string, cwd: string): string | undefined {
  if (!value || /[$`*?[{~]/.test(value)) return undefined;
  try {
    const path = canonical(resolve(cwd, value));
    if (name === "GIT_WORK_TREE") return featureCheckout(path) === path ? path : undefined;
    if (name !== "GIT_DIR") return undefined;
    if (basename(path) === ".git" && statSync(path).isFile()) {
      const top = dirname(path);
      return featureCheckout(top) === top ? top : undefined;
    }
    // A linked worktree's git directory names its worktree in `gitdir` (`<worktree>/.git`).
    const pointer = readFileSync(join(path, "gitdir"), "utf8").trim();
    const top = canonical(dirname(resolve(path, pointer)));
    if (featureCheckout(top) !== top) return undefined;
    return canonical(git(top, ["rev-parse", "--absolute-git-dir"])) === path ? top : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether git, run in `cwd` with these `GIT_DIR`/`GIT_WORK_TREE` tops, reads and writes only the
 * one verified feature worktree: both set to the same worktree, or one set and `cwd` inside that
 * worktree (git takes the other from `cwd`). With only `GIT_DIR`, git uses `cwd` as the work
 * tree, so from the main checkout it would write the main checkout.
 */
export function gitEnvConfined(
  dir: string | undefined,
  workTree: string | undefined,
  cwd: string,
): boolean {
  if (dir && workTree) return dir === workTree;
  const top = dir ?? workTree;
  if (!top) return true;
  try {
    return inside(top, canonical(cwd));
  } catch {
    return false;
  }
}

/**
 * Whether a script that sets `GIT_DIR`/`GIT_WORK_TREE` keeps git where those name: it has no
 * git option that moves git elsewhere (`-C`, `--work-tree`, `--git-dir`, `--namespace`), no
 * `pushd`/`popd`, and every `cd` is a literal path into the one verified worktree the variables
 * name. Otherwise the variables are an environment override as before.
 */
export function gitEnvScriptSafe(script: string, cwd: string): boolean {
  // Judge the words the shell will actually pass (quotes removed, line continuations joined). A
  // script the scanner cannot flatten into plain commands (loops, conditionals, background jobs,
  // unreadable words) gets no exception.
  const pipelines = parseShell(script);
  if (!pipelines) return false;
  const tops = new Set<string | undefined>();
  const commands = pipelines.flat();
  const note = (name: string, value: string) => {
    if (name === "GIT_DIR" || name === "GIT_WORK_TREE") tops.add(featureGitTop(name, value, cwd));
  };
  for (const command of commands) {
    if (command.subs.length) return false;
    for (const [name, value] of command.env) note(name, value);
    const name = basename(command.argv[0] ?? "");
    if (name === "export")
      for (const word of command.argv.slice(1)) {
        const at = word.indexOf("=");
        if (at > 0) note(word.slice(0, at), word.slice(at + 1));
      }
  }
  const [top] = tops;
  if (tops.size !== 1 || !top) return false;
  // Git global options that take a value; the subcommand follows them.
  const VALUED = new Set(["-c", "--exec-path", "--config-env", "--super-prefix", "--list-cmds"]);
  for (const command of commands) {
    const [program = "", ...args] = command.argv;
    const name = basename(program);
    if (name === "pushd" || name === "popd") return false;
    if (name === "cd") {
      const target = args.length === 1 ? args[0] : undefined;
      if (!target || target === "-" || /[$`*?[{~]/.test(target)) return false;
      try {
        if (!inside(top, canonical(resolve(cwd, target)))) return false;
      } catch {
        return false;
      }
      continue;
    }
    if (name === "git") {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string;
        if (!arg.startsWith("-")) break;
        if (/^(?:-C|--work-tree|--git-dir|--namespace)(?:=|$)|^-C./.test(arg)) return false;
        if (VALUED.has(arg)) i++;
      }
      continue;
    }
    // Anything else that could start git (wrappers, shells, xargs) voids the exception.
    if (name === "export") continue;
    if (args.some((arg) => basename(arg) === "git" || /(?:^|[\s;&|(`'"])git(?:\s|$)/.test(arg)))
      return false;
  }
  return true;
}
