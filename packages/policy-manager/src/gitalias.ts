import { git } from "./evidence.js";

/** Git's own subcommands. Any other word after `git` is an alias or an external `git-<name>`. */
export const KNOWN_GIT = new Set(
  "add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-ref-format checkout cherry cherry-pick clean clone column commit commit-tree config count-objects credential describe diff diff-files diff-index diff-tree difftool fetch filter-branch for-each-ref format-patch fsck gc grep hash-object help init interpret-trailers log ls-files ls-remote ls-tree maintenance merge merge-base merge-file merge-tree mergetool mktag mktree mv name-rev notes prune pull push range-diff read-tree rebase reflog remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email shortlog show show-branch show-ref sparse-checkout stage stash status submodule switch symbolic-ref tag update-index update-ref var verify-commit verify-pack verify-tag version whatchanged worktree write-tree".split(
    " ",
  ),
);

/**
 * What `git <name>` runs when `name` is an alias, read with `git config --get alias.<name>` in
 * `cwd` (repository, global and system configuration, as Git reads them). Undefined when it is
 * not an alias or cannot be read. A value starting with `!` is a shell command.
 */
export function gitAlias(cwd: string, name: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) return undefined;
  try {
    const value = git(cwd, ["config", "--get", `alias.${name}`]);
    return value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The directory Git runs a `!` alias in: the top level of the work tree, or `cwd` outside one. */
export function aliasDirectory(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return cwd;
  }
}

/** `args` as shell words, single-quoted, the way Git appends them to a `!` alias. */
export function shellArgs(args: string[]): string {
  return args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(" ");
}
