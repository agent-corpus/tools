import { execFileSync } from "node:child_process";
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  }).trim();
}
export function canonical(path: string, links = 0): string {
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
const CREDENTIAL_CONFIG_DIRS = /(?:^|[\\/])\.config[\\/](?:gh|gcloud|op|hub)(?:[\\/]|$)/i;

export function sensitive(path: string): boolean {
  return (
    CREDENTIAL_CONFIG_DIRS.test(path) ||
    path
      .split(/[\\/]/)
      .some((part) =>
        /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gcloud|\.docker|\.gnupg|\.password-store|\.git-credentials|\.vault-token|\.pgpass|\.my\.cnf|\.pypirc|\.npmrc|\.netrc|\.kube|credentials?|secrets?|id_rsa|id_ed25519|id_ecdsa|kubeconfig|terraform\.tfstate(?:\..*)?|.*\.(?:pem|key|pfx|p12))$/i.test(
          part,
        ),
      )
  );
}
export function protectedPath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some((part) =>
      /^(?:\.agent-config|\.local|\.codex|\.claude|\.agents|AGENTS\.md|CLAUDE\.md|\.github)$/i.test(
        part,
      ),
    );
}
/**
 * Protected names (.claude, .agent-config, AGENTS.md ...) guard a repository's own configuration,
 * so they are judged relative to the Git top level. A linked worktree that lives under
 * `<repo>/.claude/worktrees/<name>` is ordinary code, while `<worktree>/.claude/settings.json`
 * stays protected.
 */
export function isProtectedPath(path: string): boolean {
  try {
    let parent = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
    while (!existsSync(parent)) parent = dirname(parent);
    const root = canonical(git(parent, ["rev-parse", "--show-toplevel"]));
    if (protectedPath(relative(root, canonical(path)))) return true;
    // A protected name that is a symlink (`.claude -> config`) vanishes once the path is resolved,
    // so also judge the path as written, relative to the checkout it lives in.
    const written = resolve(path);
    let ancestor = dirname(written);
    while (ancestor !== dirname(ancestor)) {
      if (existsSync(ancestor) && canonical(ancestor) === root)
        return protectedPath(relative(ancestor, written));
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
export function disposable(cwd: string, input: string, roots: string[]): boolean {
  try {
    let target = input;
    if (/[*?[]/.test(input)) {
      const parts = input.split(/[\\/]/);
      const last = parts.pop() ?? "";
      if (!last || last.startsWith(".") || parts.some((part) => /[*?[]/.test(part))) return false;
      target = parts.join("/") || (parts.length ? "/" : ".");
    }
    const lexical = resolve(cwd, target);
    const path = canonical(lexical);
    if (
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
    return !holdsRepository(path);
  } catch {
    return false;
  }
}

export const OUTSIDE_REPOSITORY = "Cannot verify repository and path evidence";

export function pathEvidence(
  cwd: string,
  input: string,
  write: boolean,
): { allowed: boolean; category: "code-read" | "worktree-write" | "sensitive"; reason: string } {
  try {
    const lexical = resolve(cwd, input);
    const path = canonical(lexical);
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
