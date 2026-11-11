import { execFileSync } from "node:child_process";
import { git } from "./evidence.js";

export interface MergedEvidence {
  merged: boolean;
  how: string;
}

const BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

function target(cwd: string): string | undefined {
  for (const name of ["main", "master"]) {
    try {
      git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}^{commit}`]);
      return `refs/remotes/origin/${name}`;
    } catch {
      /* try the next default branch */
    }
  }
  return undefined;
}

/**
 * Decides whether every change on `ref` already reached origin's default branch, either by
 * ancestry (merge or fast-forward) or by squash/rebase merge (patch-equivalence of the whole
 * branch). Evidence uses the locally fetched origin/main, so stale fetches can only make the
 * answer more conservative for new work and less accurate for very recent merges.
 */
export function mergedEvidence(cwd: string, ref: string): MergedEvidence {
  const branch = ref.replace(/^refs\/(?:heads|remotes\/origin)\//, "");
  if (!BRANCH_NAME.test(branch) || /^(?:main|master|HEAD)$/.test(branch))
    return { merged: false, how: "protected or unverifiable branch name" };
  const into = target(cwd);
  if (!into) return { merged: false, how: "origin default branch is not fetched" };
  try {
    const tip = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    try {
      git(cwd, ["merge-base", "--is-ancestor", tip, into]);
      return { merged: true, how: "reachable from origin default branch" };
    } catch {
      /* not an ancestor; test for a squash or rebase merge */
    }
    const base = git(cwd, ["merge-base", tip, into]);
    const tree = git(cwd, ["rev-parse", `${tip}^{tree}`]);
    // commit-tree writes one unreachable object; it never touches refs, the index or the worktree.
    const synthetic = execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-C",
        cwd,
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        "squash probe",
      ],
      {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
          ),
          GIT_AUTHOR_NAME: "policy-manager",
          GIT_AUTHOR_EMAIL: "policy-manager@localhost",
          GIT_COMMITTER_NAME: "policy-manager",
          GIT_COMMITTER_EMAIL: "policy-manager@localhost",
        },
      },
    ).trim();
    const cherry = git(cwd, ["cherry", into, synthetic]);
    if (cherry?.split("\n").every((line) => line.startsWith("-")))
      return {
        merged: true,
        how: "patch-equivalent to a squash or rebase merge into origin default",
      };
    return { merged: false, how: "branch has changes absent from origin default branch" };
  } catch {
    return { merged: false, how: "merge state could not be verified" };
  }
}

/** The remote tip must match the fetched tracking ref, or a delete could discard unseen commits. */
export function remoteTipMatches(cwd: string, branch: string): boolean {
  try {
    const local = git(cwd, ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`]);
    const remote = execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-C",
        cwd,
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${branch}`,
      ],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return remote.split(/\s+/)[0] === local;
  } catch {
    return false;
  }
}
