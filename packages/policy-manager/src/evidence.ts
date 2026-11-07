import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
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
export function canonical(path: string): string {
  // Native resolution expands Windows 8.3 aliases as well as symlinks, so
  // paths supplied by Node and Git describe the same repository boundaries.
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  if (parent === path) throw new Error("Cannot resolve path");
  return resolve(canonical(parent), basename(path));
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export function sensitive(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some((part) =>
      /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.kube|\.npmrc|\.netrc|credentials?|secrets?|id_rsa|id_ed25519|id_ecdsa|kubeconfig|terraform\.tfstate(?:\..*)?|.*\.(?:pem|key|pfx|p12))$/i.test(
        part,
      ),
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
      (write && (protectedPath(path) || protectedPath(lexical)))
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
      reason: "Cannot verify repository and path evidence",
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
