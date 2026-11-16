import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  canonical,
  git,
  inside,
  policyState,
  protectedPath,
  resolveWord,
  sensitive,
} from "./evidence.js";
import { SHELL_TOOLS, words } from "./policy.js";
import type { Profile } from "./profile.js";
import { parseShell, SUBSTITUTION } from "./shell.js";
import type { Decision, Request } from "./types.js";

export const PROTECTED_PATH = "Protected path requires human approval";
export const HUMAN_PATTERN = "Matches an organization human-approval pattern";
const FILE_TOOLS = new Set(["Write", "create", "write_file", "Edit", "edit", "MultiEdit"]);

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

/** The paths a request names: file tool targets, patch headers, or a simple command's path words. */
function targets(request: Request): string[] | undefined {
  const input = request.input;
  if (FILE_TOOLS.has(request.tool)) {
    const file = input.file_path ?? input.path;
    return typeof file === "string" ? [file] : undefined;
  }
  if (request.tool === "apply_patch") {
    const patch = input.command ?? input.patch ?? input.input;
    if (typeof patch !== "string") return undefined;
    const found = patch
      .split("\n")
      .flatMap((line) =>
        /^\*\*\* (?:Add File|Update File|Delete File|Move to): /.test(line)
          ? [line.slice(line.indexOf(": ") + 2).trim()]
          : [],
      );
    return found.length ? found : undefined;
  }
  return undefined;
}

/**
 * Every word of a single shell command that could name a file it touches: non-option arguments,
 * the value of `--option=value` or `-oVALUE`, and redirect targets (`> f`, `>> f`, `< f`). One program, no
 * operators, pipes, substitutions or variables. A word that is not a path only adds a scope, so
 * treating it as one fails closed.
 */
function shellPaths(request: Request): string[] | undefined {
  const command = request.input.command ?? request.input.cmd;
  if (!SHELL_TOOLS.has(request.tool) || typeof command !== "string") return undefined;
  const pipelines = parseShell(command);
  const only = pipelines?.length === 1 && pipelines[0]?.length === 1 ? pipelines[0][0] : undefined;
  if (!only || only.env.length || only.subs.length || only.stdin !== undefined) return undefined;
  const texts = [...only.argv, ...only.redirects.map((r) => r.target)];
  if (texts.some((text) => text.includes(SUBSTITUTION))) return undefined;
  const paths: string[] = [];
  for (const word of only.argv.slice(1)) {
    if (!word.startsWith("-")) paths.push(word);
    else if (word.startsWith("--")) {
      if (word.includes("=")) paths.push(word.slice(word.indexOf("=") + 1));
    }
    // `-oFILE` attaches a value to a short option; flags like `-rf` only add a harmless path.
    else if (word.length > 2) paths.push(word.slice(2).replace(/^=/, ""));
  }
  for (const redirect of only.redirects)
    if (redirect.op !== ">&" && redirect.target !== "/dev/null") paths.push(redirect.target);
  return paths.filter((path) => path.length > 0);
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
 * - a protected-path write: the exact files it writes, in the same checkout;
 * - any other rule for a simple command (a humanPatterns match included): that exact command, in
 *   the same checkout.
 * Category unknown, sensitive or destructive, the ONCE_ONLY hard items, and anything whose targets
 * cannot be read from the request are approved once only. Shell scopes need a simple command, so
 * nothing else in the script hides behind the rule.
 */
export function grantScope(
  request: Request,
  decision: Decision,
  profile: Profile,
): string | undefined {
  try {
    if (decision.hard && ONCE_ONLY.has(decision.hard)) return undefined;
    if (decision.reason === PROTECTED_PATH) {
      const paths = targets(request) ?? shellPaths(request);
      if (!paths?.length) return undefined;
      const files = new Set<string>();
      let top: string | undefined;
      for (const path of paths) {
        const lexical = resolveWord(request.cwd, path);
        if (sensitive(lexical) || policyState(lexical)) return undefined;
        const resolved = canonical(lexical);
        if (sensitive(resolved) || policyState(resolved)) return undefined;
        // A word that is not under a protected root (`printf test >> AGENTS.md`) is not the write.
        if (!protectedRoot(resolved)) continue;
        const checkout = topLevel(resolved);
        if (top !== undefined && checkout !== top) return undefined;
        top = checkout;
        files.add(resolved);
      }
      return files.size ? `protected:${[...files].sort().join("\u0000")}` : undefined;
    }
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
