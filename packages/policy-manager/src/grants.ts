import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  canonical,
  git,
  inside,
  noteProtectedWrites,
  policyState,
  protectedPath,
  sensitive,
} from "./evidence.js";
import { hardRules } from "./hard.js";
import { evaluate, SHELL_TOOLS, words } from "./policy.js";
import type { Profile } from "./profile.js";
import { SUBSTITUTION } from "./shell.js";
import type { Decision, Request } from "./types.js";

export const PROTECTED_PATH = "Protected path requires human approval";
export const HUMAN_PATTERN = "Matches an organization human-approval pattern";

function topLevel(path: string): string {
  let parent = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  while (!existsSync(parent)) parent = dirname(parent);
  return canonical(git(parent, ["rev-parse", "--show-toplevel"]));
}

/** `<checkout>/<first protected name>` for a path inside a protected directory of a checkout. */
function protectedRoot(path: string): string | undefined {
  const top = topLevel(path);
  const target = canonical(path);
  if (!inside(top, target)) return undefined;
  const parts = relative(top, target).split(/[\\/]/);
  const index = parts.findIndex((part) => protectedPath(part));
  return index < 0 ? undefined : join(top, ...parts.slice(0, index + 1));
}

/** A word whose text the shell could change: a variable, substitution, glob or brace. */
const UNREADABLE = /[*?[\]{}$`]/;

/**
 * The exact protected files a request writes, read by the engine itself: it judges the request
 * with each write it would refuse only for a protected (not credential) name noted and allowed.
 * Undefined unless the engine then approves everything else in the request (reads, `mkdir -p`,
 * echo and printf, floor checks included), every noted target is a literal word, outside policy
 * state, under a protected root of one checkout, and no hard rule but "protected" applies.
 */
function protectedScope(
  request: Request,
  decision: Decision,
  profile: Profile,
): string | undefined {
  if (hardRules(request, decision, profile.scratchRoots).some((rule) => rule !== "protected"))
    return undefined;
  const { value, writes } = noteProtectedWrites(() => evaluate(request, undefined, profile));
  if (value.decision !== "approve" || !writes.length) return undefined;
  const files = new Set<string>();
  const directories = new Set<string>();
  let top: string | undefined;
  for (const write of writes) {
    if (write.word.includes(SUBSTITUTION) || UNREADABLE.test(write.word)) return undefined;
    if (policyState(write.lexical) || policyState(write.path)) return undefined;
    if (!protectedRoot(write.path)) return undefined;
    const checkout = topLevel(write.path);
    if (top !== undefined && checkout !== top) return undefined;
    top = checkout;
    (write.directory ? directories : files).add(write.path);
  }
  // `mkdir -p` of a written file's own parent directories is part of writing that file.
  for (const directory of directories)
    if (![...files].some((file) => file !== directory && inside(directory, file)))
      files.add(directory);
  return `protected:${[...files].sort().join("\u0000")}`;
}

/** A simple command (one program, no operators, expansions or redirects) as words. */
function simple(request: Request): string[] | undefined {
  const command = request.input.command ?? request.input.cmd;
  if (!SHELL_TOOLS.has(request.tool) || typeof command !== "string") return undefined;
  const argv = words(command);
  return argv?.length ? argv : undefined;
}

/**
 * Hard items a session grant never covers: possible unrecoverable loss, credentials, the policy
 * manager's own guards, deterministic-floor items, and every file that changes what the harness
 * allows (settings, hooks, permission rules, the policy profile). Each is asked every time.
 */
const ONCE_ONLY = new Set([
  "force-push",
  "delete-unmerged-branch",
  "remove-worktree-force",
  "git-clean",
  "credential-read",
  "harness-settings",
  "policy-profile",
  "policy-state",
  "opaque-script",
  "self-approve",
  "foreign-classification-record",
  "cloud-write",
  "repo-delete",
  "publish",
  "rm-outside",
]);

/**
 * The scope a session approval of this human decision covers, or undefined when it can only be
 * approved once. A scope is always the same rule and the same exact target:
 * - a protected-path write: the exact files it writes, in the same checkout, in any script whose
 *   every other part the engine approves on its own (see `protectedScope`);
 * - any other rule for a simple command (a humanPatterns match included): that exact command, in
 *   the same checkout.
 * Category unknown, sensitive or destructive, the ONCE_ONLY hard items, and anything whose targets
 * cannot be read from the request are approved once only. Command scopes need a simple command, so
 * nothing else in the script hides behind the rule.
 */
export function grantScope(
  request: Request,
  decision: Decision,
  profile: Profile,
): string | undefined {
  try {
    if (decision.hard && ONCE_ONLY.has(decision.hard)) return undefined;
    if (decision.reason === PROTECTED_PATH) return protectedScope(request, decision, profile);
    const argv = simple(request);
    if (!argv) return undefined;
    const checkout = topLevel(request.cwd);
    if (decision.reason !== HUMAN_PATTERN) {
      if (
        decision.category === "sensitive" ||
        decision.category === "destructive" ||
        decision.category === "unknown"
      )
        return undefined;
    } else if (!profile.humanPatterns.some((pattern) => pattern.test(argv.join(" "))))
      return undefined;
    if (argv.slice(1).some((word) => sensitive(word))) return undefined;
    return `command:${decision.reason}:${JSON.stringify(argv)}:${checkout}`;
  } catch {
    return undefined;
  }
}

/** What a session scope covers, in words the user can check before approving it. */
export function scopeLabel(scope: string, _profile: Profile): string {
  if (scope.startsWith("protected:"))
    return `writes to ${scope.slice("protected:".length).split("\u0000").join(", ")}`;
  const rest = scope.slice(scope.indexOf(":[") + 1);
  const end = rest.lastIndexOf("]:");
  const argv = JSON.parse(rest.slice(0, end + 1)) as string[];
  return `the exact command \`${argv.join(" ")}\` in ${rest.slice(end + 2)}`;
}
