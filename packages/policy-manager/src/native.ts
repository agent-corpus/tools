import { resolve } from "node:path";
import { resolveWord } from "./evidence.js";
import { SHELL_TOOLS } from "./policy.js";
import { defaultProfilePath } from "./profile.js";
import {
  ALWAYS_ASK_RULES,
  type AlwaysAskRule,
  type Category,
  type Decision,
  type Request,
} from "./types.js";

/**
 * The policy manager is never stricter than the harness on its own: a decision that needs a person
 * is left to the harness's native permission flow (its rules, its prompt and its "don't ask again"
 * choice), except for the profile's `alwaysAsk` hard list (ALWAYS_ASK_RULES by default).
 */
export { ALWAYS_ASK_RULES };

/** An agent running `approve` itself always asks; no profile can turn this off. */
export const SELF_APPROVE = "self-approve";
/** A classification record for another session or CLI, or with anything added, always asks. */
export const FOREIGN_RECORD = "foreign-classification-record";
const FOREIGN_RECORD_REASON = /^A classification record for another session or CLI/;
/** Built-in rules that guard the policy manager's own approvals; no profile can remove them. */
export const BUILT_IN_RULES: readonly string[] = [SELF_APPROVE, FOREIGN_RECORD];

const REASON_RULES: Array<[RegExp, AlwaysAskRule]> = [
  [/^Force or mirror pushes overwrite remote history$/, "force-push"],
  [/^Forced refspecs overwrite remote history$/, "force-push"],
  [/^Local branch deletion requires human approval/, "delete-unmerged-branch"],
  [/^Remote branch deletion may lose work/, "delete-unmerged-branch"],
  [/^Remote branch has commits that are not fetched/, "delete-unmerged-branch"],
  [/^Forced worktree removal requires human approval$/, "remove-worktree-force"],
  [/^git clean deletes untracked files$/, "git-clean"],
];

/**
 * The same rules matched on the text of a shell command the engine could not parse (braces,
 * variables, compound scripts), so an unparsed form never slips past the hard list. Only a
 * decision that already needs a person is matched, so a false match asks rather than approves.
 */
const SEGMENT = String.raw`[^;&|\n]*`;
/** `git`, its global options, then the subcommand. */
const GIT = String.raw`\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+`;
const TEXT_RULES: Array<[RegExp, AlwaysAskRule]> = [
  [
    new RegExp(
      String.raw`${GIT}push\b${SEGMENT}(?:\s(?:--force\S*|--mirror|--prune|-[a-zA-Z]*f[a-zA-Z]*)(?=\s|$)|\s["']?\+\S)`,
    ),
    "force-push",
  ],
  [
    new RegExp(
      String.raw`${GIT}branch\b${SEGMENT}\s(?:-[a-zA-Z]*[dD][a-zA-Z]*|--delete)(?=\s|$)|${GIT}push\b${SEGMENT}\s(?:--delete|-[a-zA-Z]*d[a-zA-Z]*(?=\s|$)|["']?:\S)`,
    ),
    "delete-unmerged-branch",
  ],
  [
    new RegExp(
      String.raw`${GIT}worktree\s+(?:remove${SEGMENT}\s(?:--force|-[a-zA-Z]*f[a-zA-Z]*)(?=\s|$)|prune\b)`,
    ),
    "remove-worktree-force",
  ],
  [new RegExp(String.raw`${GIT}clean\b(?!${SEGMENT}\s(?:-[a-zA-Z]*n|--dry-run))`), "git-clean"],
];

function textRule(request: Request): AlwaysAskRule | undefined {
  const command = request.input.command ?? request.input.cmd;
  if (!(SHELL_TOOLS.has(request.tool) || request.tool === "powershell")) return undefined;
  if (typeof command !== "string") return undefined;
  return TEXT_RULES.find(([pattern]) => pattern.test(command))?.[1];
}

const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "create",
  "edit",
  "write_file",
]);

/** Harness permission and hook settings, by name, in any harness configuration directory. */
const HARNESS_SETTINGS = [
  /(?<![\w-])\.claude[\\/]+settings(?:\.local)?\.json(?![\w.-])/i,
  /(?<![\w-])\.codex[\\/]+(?:hooks\.json|config\.toml)(?![\w.-])/i,
  /(?<![\w-])\.copilot[\\/]+hooks(?![\w.-])/i,
];
const PROFILE_NAME = /(?<![\w-])policy-manager[\\/]+policy\.json(?![\w.-])/i;

/** Settings files in a harness directory moved by an environment variable. */
function configuredSettings(path: string): boolean {
  const dirs: Array<[string | undefined, RegExp]> = [
    [process.env.CLAUDE_CONFIG_DIR, /^settings(?:\.local)?\.json$/i],
    [process.env.CODEX_HOME, /^(?:hooks\.json|config\.toml)$/i],
    [process.env.COPILOT_HOME, /^hooks(?:[\\/]|$)/i],
  ];
  return dirs.some(([dir, name]) => {
    if (!dir) return false;
    const root = `${resolve(dir)}/`.replace(/\\/g, "/");
    const target = path.replace(/\\/g, "/");
    return target.startsWith(root) && name.test(target.slice(root.length));
  });
}

/** The texts that can name what a request writes: write targets, patch headers, a shell command. */
function writeTexts(request: Request): string[] {
  const input = request.input;
  if (WRITE_TOOLS.has(request.tool)) {
    const file = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof file !== "string") return [];
    try {
      return [file, resolveWord(request.cwd || "/", file)];
    } catch {
      return [file];
    }
  }
  if (request.tool === "apply_patch") {
    const patch = input.command ?? input.patch ?? input.input;
    if (typeof patch !== "string") return [];
    return patch
      .split("\n")
      .filter((line) => /^\*\*\* (?:Add File|Update File|Delete File|Move to): /.test(line))
      .flatMap((line) => {
        const file = line.slice(line.indexOf(": ") + 2).trim();
        try {
          return [file, resolveWord(request.cwd || "/", file)];
        } catch {
          return [file];
        }
      });
  }
  // A shell command is matched as text: whatever it does to these files is a person's decision.
  const command = input.command ?? input.cmd;
  return (SHELL_TOOLS.has(request.tool) || request.tool === "powershell") &&
    typeof command === "string"
    ? [command]
    : [];
}

function settingsRule(request: Request): AlwaysAskRule | undefined {
  const texts = writeTexts(request);
  const profile = defaultProfilePath();
  if (texts.some((text) => text === profile || PROFILE_NAME.test(text) || text.includes(profile)))
    return "policy-profile";
  if (texts.some((text) => HARNESS_SETTINGS.some((p) => p.test(text)) || configuredSettings(text)))
    return "harness-settings";
  return undefined;
}

/** The reason of session's approve guard (an agent running `approve`). */
export const APPROVE_GUARD =
  "Only the user may approve a request, by running approve in their own terminal";

/** The hard-list rule a decision that needs a person falls under, if any. */
export function alwaysAskRule(request: Request, decision: Decision): string | undefined {
  if (decision.userOnly || decision.reason === APPROVE_GUARD) return SELF_APPROVE;
  if (FOREIGN_RECORD_REASON.test(decision.reason)) return FOREIGN_RECORD;
  for (const [pattern, rule] of REASON_RULES) if (pattern.test(decision.reason)) return rule;
  return settingsRule(request) ?? textRule(request);
}

/**
 * Whether a decision that needs a person still asks under `alwaysAsk`: it matches a listed rule
 * id or category, or a built-in rule. Returns the matched entry.
 */
export function stillAsks(
  request: Request,
  decision: Decision,
  alwaysAsk: readonly string[],
): string | undefined {
  const rule = alwaysAskRule(request, decision);
  if (rule && BUILT_IN_RULES.includes(rule)) return rule;
  if (rule && alwaysAsk.includes(rule)) return rule;
  if (alwaysAsk.includes(decision.category as Category)) return decision.category;
  return undefined;
}

/**
 * A `human` decision becomes `native` (no hook decision) unless it is on the hard list; the
 * reason it would have asked is kept in `deferred` for the audit log and reviews.
 */
export function deferToNative(
  request: Request,
  decision: Decision,
  alwaysAsk: readonly string[],
): Decision {
  if (decision.decision !== "human") return decision;
  const rule = stillAsks(request, decision, alwaysAsk);
  if (rule) return { ...decision, alwaysAsk: rule };
  return { ...decision, decision: "native", deferred: decision.reason };
}
