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
 * The scope a `--session` approval of this human decision covers, or undefined when it can only
 * be approved once. Credential and secret reads, possible unrecoverable loss and anything whose
 * targets cannot be read from the request stay one-time. Scopes:
 * - a protected-path write: the protected roots it touches (`<worktree>/.agent-config`);
 * - a humanPatterns match: the matching patterns, in the same checkout;
 * - any other human rule for a simple command: that exact command, same checkout.
 * Category unknown (the engine could not rule out loss) is approved once only.
 * Shell scopes need a simple command, so nothing else in the script hides behind the rule.
 */
export function grantScope(
  request: Request,
  decision: Decision,
  profile: Profile,
): string | undefined {
  try {
    if (decision.reason === PROTECTED_PATH) {
      const paths = targets(request) ?? shellPaths(request);
      if (!paths?.length) return undefined;
      const roots = new Set<string>();
      let top: string | undefined;
      for (const path of paths) {
        const lexical = resolveWord(request.cwd, path);
        if (sensitive(lexical) || policyState(lexical)) return undefined;
        const resolved = canonical(lexical);
        if (sensitive(resolved) || policyState(resolved)) return undefined;
        const root = protectedRoot(resolved);
        const checkout = topLevel(resolved);
        if (top !== undefined && checkout !== top) return undefined;
        top = checkout;
        if (root) roots.add(root);
      }
      return roots.size ? `protected:${[...roots].sort().join("\u0000")}` : undefined;
    }
    const argv = simple(request);
    if (!argv) return undefined;
    const checkout = topLevel(request.cwd);
    if (decision.reason === HUMAN_PATTERN) {
      const joined = argv.join(" ");
      const matched = profile.humanPatterns.flatMap((pattern, index) =>
        pattern.test(joined) ? [index] : [],
      );
      return matched.length ? `pattern:${matched.join(",")}:${checkout}` : undefined;
    }
    if (
      decision.category === "sensitive" ||
      decision.category === "destructive" ||
      decision.category === "unknown"
    )
      return undefined;
    if (argv.slice(1).some((word) => sensitive(word))) return undefined;
    return `command:${decision.reason}:${JSON.stringify(argv)}:${checkout}`;
  } catch {
    return undefined;
  }
}

/** What a session scope covers, in words the user can check before approving it. */
export function scopeLabel(scope: string, profile: Profile): string {
  if (scope.startsWith("protected:"))
    return `writes ${scope
      .slice("protected:".length)
      .split("\u0000")
      // A root that is a file (`AGENTS.md`) is written to; a directory, or one not made yet, under.
      .map((root) => (existsSync(root) && !statSync(root).isDirectory() ? "to " : "under ") + root)
      .join(", ")}`;
  if (scope.startsWith("pattern:")) {
    const [, indexes = "", ...checkout] = scope.split(":");
    const patterns = indexes
      .split(",")
      .map((index) => profile.humanPatterns[Number(index)]?.source ?? index)
      .join(", ");
    return `commands matching ${patterns} in ${checkout.join(":")}`;
  }
  const rest = scope.slice(scope.indexOf(":[") + 1);
  const end = rest.lastIndexOf("]:");
  const argv = JSON.parse(rest.slice(0, end + 1)) as string[];
  return `the exact command \`${argv.join(" ")}\` in ${rest.slice(end + 2)}`;
}
