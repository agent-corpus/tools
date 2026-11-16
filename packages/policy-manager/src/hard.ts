import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveWord, sensitive } from "./evidence.js";
import { aliasDirectory, gitAlias, KNOWN_GIT, shellArgs } from "./gitalias.js";
import { defaultProfilePath } from "./profile.js";
import { type Command, command, innerScript, scan, type Word } from "./shellscan.js";
import type { Decision, Request } from "./types.js";

/**
 * Hard human items: requests that always go to a person, are never sent to the AI classifier, and
 * that no classification can approve. Credentials, protected configuration, unrecoverable loss and
 * the profile's humanPatterns, plus two built-in guards on the policy manager's own approvals.
 */
export const HARD_RULES = [
  /** Credential or secret retrieval, and reads of credential paths. */
  "credential-read",
  /** Writes to harness permission and hook settings. */
  "harness-settings",
  /** Writes to the policy profile itself. */
  "policy-profile",
  /** `git push --force`/`--mirror`, and `+` refspecs: they overwrite remote history. */
  "force-push",
  /** Deleting a local or remote branch whose commits are not verified merged. */
  "delete-unmerged-branch",
  /** `git worktree remove --force`/`prune`: discards a worktree's uncommitted and untracked work. */
  "remove-worktree-force",
  /** `git clean`: deletes untracked files. */
  "git-clean",
  /** A command matching the profile's `humanPatterns`. */
  "human-patterns",
  /** Any other decision the engine filed as sensitive: protected paths and configuration. */
  "protected",
  /** An agent running `approve` itself. */
  "self-approve",
  /** A classification record for another session or CLI, or with anything added. */
  "foreign-classification-record",
] as const;
export type HardRule = (typeof HARD_RULES)[number];

/** The reason of session's approve guard (an agent running `approve`). */
export const APPROVE_GUARD =
  "Only the user may approve a request, by running approve in their own terminal";
const FOREIGN_RECORD_REASON = /^A classification record for another session or CLI/;

/** The engine's own reasons for hard cases it parsed. */
const REASON_RULES: Array<[RegExp, HardRule]> = [
  [/^Force or mirror pushes overwrite remote history$/, "force-push"],
  [/^Forced refspecs overwrite remote history$/, "force-push"],
  [/^Local branch deletion requires human approval/, "delete-unmerged-branch"],
  [/^Remote branch deletion may lose work/, "delete-unmerged-branch"],
  [/^Remote branch has commits that are not fetched/, "delete-unmerged-branch"],
  [/^Remote branch deletion is only verified for origin/, "delete-unmerged-branch"],
  [/^Only branch deletions with verified merge state/, "delete-unmerged-branch"],
  [/^Forced worktree removal requires human approval$/, "remove-worktree-force"],
  [/^git clean deletes untracked files$/, "git-clean"],
  [/^Matches an organization human-approval pattern$/, "human-patterns"],
  [/credential|secret|Printing the environment/i, "credential-read"],
];

const SHELL_TOOLS = new Set(["Bash", "bash", "exec_command", "shell", "powershell"]);
const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "create",
  "edit",
  "write_file",
]);

/**
 * Harness permission, hook and MCP settings, matched on a path with `/` separators. Each names
 * files that change what the harness lets run, or that run with the user's rights.
 */
const HARNESS_SETTINGS = [
  // Claude Code: settings (permissions, hooks), hook scripts, and user MCP servers.
  /(?<![\w-])\.claude\/settings(?:\.local)?\.json$/i,
  /(?<![\w-])\.claude\/hooks(?:\/|$)/i,
  /(?<![\w-])\.claude\.json$/i,
  // Codex: hooks, hook scripts, configuration (approval policy, sandbox, MCP) and command rules.
  /(?<![\w-])\.codex\/(?:hooks\.json|config\.toml)$/i,
  /(?<![\w-])\.codex\/(?:hooks|rules)(?:\/|$)/i,
  // Copilot: user hooks, configuration and saved permissions, and repository hooks.
  /(?<![\w-])\.copilot\/(?:config\.json|settings\.json|permissions-config\.json|hooks(?:\/|$))/i,
  /(?<![\w-])\.github\/hooks(?:\/[^/]*\.json)?$/i,
];
/** File names a write in an unknown directory could be a harness setting through. */
const SETTINGS_NAMES =
  /^(?:settings(?:\.local)?\.json|\.claude\.json|hooks\.json|config\.toml|config\.json|policy\.json|permissions-config\.json|hooks|rules)$/i;
const PROFILE_NAME = /(?<![\w-])policy-manager\/policy\.json$/i;

const slashes = (path: string) => path.replace(/\\/g, "/");

/**
 * `path` with `/` separators, runs of separators collapsed and no trailing one. Done by splitting,
 * not a regular expression, so a long run of slashes in hook input costs linear time.
 */
function normalize(path: string): string {
  return slashes(path)
    .split("/")
    .filter((part, index) => part !== "" || index === 0)
    .join("/");
}

/** Settings in a harness directory moved by an environment variable. */
function configuredSettings(path: string): boolean {
  const dirs: Array<[string | undefined, RegExp]> = [
    [
      process.env.CLAUDE_CONFIG_DIR,
      /^(?:settings(?:\.local)?\.json|\.claude\.json|hooks(?:\/|$))/i,
    ],
    [process.env.CODEX_HOME, /^(?:hooks\.json|config\.toml|(?:hooks|rules)(?:\/|$))/i],
    [
      process.env.COPILOT_HOME,
      /^(?:config\.json|settings\.json|permissions-config\.json|hooks(?:\/|$))/i,
    ],
  ];
  const target = slashes(path);
  return dirs.some(([dir, name]) => {
    if (!dir) return false;
    const root = `${slashes(resolve(dir))}/`;
    return target.startsWith(root) && name.test(target.slice(root.length));
  });
}

/** The hard rules a path names. */
function pathRules(path: string, rules: Set<HardRule>, credentials: boolean): void {
  const target = normalize(path);
  if (target === slashes(defaultProfilePath()) || PROFILE_NAME.test(target))
    rules.add("policy-profile");
  if (HARNESS_SETTINGS.some((pattern) => pattern.test(target)) || configuredSettings(target))
    rules.add("harness-settings");
  if (credentials && sensitive(target)) rules.add("credential-read");
}

/** Absolute forms of a shell word in each directory it could be resolved in. */
function resolutions(word: string, cwds: Set<string>): string[] {
  const found: string[] = [];
  for (const cwd of cwds)
    try {
      found.push(resolveWord(cwd, word));
    } catch {
      /* `~user` and the like: matched as written */
    }
  return found;
}

/** Global options that take the next word as their value. */
const GIT_VALUED = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
]);

/** Whether `flag` is a long option `name` or an abbreviation Git accepts (at least `min` long). */
function long(flag: string, name: string, min = 4): boolean {
  const given = flag.split("=")[0] as string;
  return given.length >= min && name.startsWith(given);
}
const short = (flag: string, letters: RegExp) =>
  /^-[a-zA-Z]+$/.test(flag) && letters.test(flag.slice(1));

const FORCE_PUSH = ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--prune"];
const forcing = (flag: string) =>
  FORCE_PUSH.some((name) => long(flag, name, 3)) || short(flag, /f/);

/** The rules a Git invocation with a literal, known subcommand falls under. */
function gitRules(sub: string, rest: string[], rules: Set<HardRule>): void {
  const flags = rest.filter((word) => word.startsWith("-"));
  const positional = rest.filter((word) => !word.startsWith("-"));
  const has = (test: (flag: string) => boolean) => flags.some(test);
  if (sub === "push") {
    if (has(forcing) || positional.some((word) => word.startsWith("+"))) rules.add("force-push");
    if (
      has((f) => long(f, "--delete") || short(f, /d/)) ||
      positional.slice(1).some((w) => w.startsWith(":"))
    )
      rules.add("delete-unmerged-branch");
  } else if (sub === "branch") {
    if (has((f) => long(f, "--delete") || short(f, /[dD]/))) rules.add("delete-unmerged-branch");
  } else if (sub === "update-ref") {
    if (has((f) => f === "-d" || long(f, "--stdin"))) rules.add("delete-unmerged-branch");
  } else if (sub === "worktree") {
    if (
      positional[0] === "prune" ||
      (positional[0] === "remove" && has((f) => long(f, "--force") || short(f, /f/)))
    )
      rules.add("remove-worktree-force");
  } else if (sub === "clean") {
    if (!has((f) => long(f, "--dry-run") || short(f, /n/))) rules.add("git-clean");
  }
}

/**
 * The rules an opaque Git invocation could reach, judged on every word of the script: its program
 * or subcommand is not a literal known word, or an alias or environment could change what runs.
 */
function opaqueGitRules(words: string[], keywords: boolean, rules: Set<HardRule>): void {
  const has = (word: string) => words.includes(word);
  const flags = words.filter((word) => word.startsWith("-") || word.startsWith("+"));
  if (has("clean") && !flags.some((f) => long(f, "--dry-run") || short(f, /n/)))
    rules.add("git-clean");
  if (flags.some((f) => forcing(f) || f.startsWith("+")) && (!keywords || has("push")))
    rules.add("force-push");
  if (has("worktree") && (has("prune") || (has("remove") && flags.some(forcing))))
    rules.add("remove-worktree-force");
  if (
    flags.some((f) => f === "--delete" || short(f, /[dD]/)) &&
    (!keywords || has("branch") || has("push") || has("update-ref"))
  )
    rules.add("delete-unmerged-branch");
}

const CLOUD = new Set(["az", "aws", "gcloud"]);
const SECRET_WORD =
  /(?:secret|credential|password|connection[-_]?strings?|(?:^|[-_])keys?(?:$|[-_])|listKeys|access-token|get-token|kubeconfig)/i;

interface Context {
  cwds: Set<string>;
  unknownCwd: boolean;
  /** Every word of the script and of the scripts it runs, for scripts that cannot be read. */
  words: string[];
  /** The words of every assignment's value, which an expansion can bring into a command. */
  assigned: string[];
}

/** A word's text as the words it could split into (`X="push --force"; git $X`). */
function split(word: Word): string[] {
  const text = /^[A-Za-z_]\w*\+?=/.test(word.text)
    ? word.text.slice(word.text.indexOf("=") + 1)
    : word.text;
  return text.split(/\s+/).filter(Boolean);
}

function analyzeScript(
  script: string,
  context: Context,
  rules: Set<HardRule>,
  depth: number,
): void {
  const { segments, complete } = scan(script);
  for (const segment of segments)
    for (const word of segment) {
      context.words.push(...split(word));
      if (/^[A-Za-z_]\w*\+?=/.test(word.text)) context.assigned.push(...split(word));
    }
  // A script the scanner could not read fully is judged on its words alone.
  if (!complete) opaqueGitRules(context.words, true, rules);
  for (const segment of segments) analyzeCommand(command(segment), segment, context, rules, depth);
}

function analyzeCommand(
  cmd: Command,
  segment: Word[],
  context: Context,
  rules: Set<HardRule>,
  depth: number,
): void {
  // Every word could name a file: arguments, redirect targets, assignment values.
  for (const word of segment) {
    const text = word.text.replace(/^[A-Za-z_]\w*=/, "").replace(/^--?[\w-]+=/, "");
    if (!text) continue;
    pathRules(text, rules, true);
    for (const path of resolutions(text, context.cwds)) pathRules(path, rules, true);
    const relative = !text.startsWith("/") && !text.startsWith("~") && !text.startsWith("$");
    if (context.unknownCwd && relative && SETTINGS_NAMES.test(text.split("/").pop() ?? ""))
      rules.add("harness-settings");
  }
  const program = cmd.program;
  if (!program) return;
  const name = program.text.split(/[\\/]/).pop() ?? "";
  const args = cmd.args.map((word) => word.text);
  if (program.literal && name === "cd") {
    const target = cmd.args.find((word) => !word.text.startsWith("-"));
    if (!target) context.cwds.add(homedir());
    else if (!target.literal) context.unknownCwd = true;
    else {
      const found = resolutions(target.text, context.cwds);
      if (found.length) for (const path of found) context.cwds.add(path);
      else context.unknownCwd = true;
    }
    return;
  }
  const inner = innerScript(cmd);
  if (inner) {
    if (depth < 4) analyzeScript(inner.script, context, rules, depth + 1);
    // An expanded script is not known: judge it on every word the script names.
    if (!inner.literal || depth >= 4) opaqueGitRules(context.words, true, rules);
    return;
  }
  if (program.literal && CLOUD.has(name)) {
    if (args.some((arg) => SECRET_WORD.test(arg))) rules.add("credential-read");
    return;
  }
  if (program.literal && name !== "git") return;
  // `git`, or a program that is not a literal word (`$GIT`), which could be Git.
  let opaque =
    !program.literal ||
    cmd.assignments.some((word) => /^GIT_/.test(word.text)) ||
    // `env GIT_DIR=...`, `GIT_CONFIG_*` and the like change what Git reads or runs.
    segment.some((word) => /^GIT_[A-Z_]*=/.test(word.text));
  let i = 0;
  /** A `-c remote.*` or `push.*` setting can make a plain push forced or mirrored. */
  let pushConfig = false;
  while (i < cmd.args.length && cmd.args[i]?.text.startsWith("-")) {
    const word = cmd.args[i] as Word;
    if (!word.literal || /^--exec-path/.test(word.text) || /^-c.*alias\./i.test(word.text))
      opaque = true;
    if (/^-c(?:remote|push)\./i.test(word.text)) pushConfig = true;
    if (GIT_VALUED.has(word.text)) {
      const value = cmd.args[i + 1];
      if (
        (word.text === "-c" || word.text === "--config-env") &&
        /^(?:remote|push)\./i.test(value?.text ?? "")
      )
        pushConfig = true;
      // A configuration value can define an alias; a directory (`-C $W`) cannot change what runs.
      if (
        (word.text === "-c" || word.text === "--config-env") &&
        (!value?.literal || /alias\./i.test(value.text))
      )
        opaque = true;
      i += 2;
    } else i++;
  }
  const sub = cmd.args[i];
  // A literal word Git does not know may be an alias: judge what it expands to, in each
  // directory the command could run in (with `-C` applied, as Git reads it).
  if (!opaque && sub?.literal && !KNOWN_GIT.has(sub.text) && program.literal && depth < 4) {
    const dirs = [...context.cwds].map((dir) => {
      const at = args.slice(0, i).lastIndexOf("-C");
      return at >= 0 && args[at + 1] ? resolve(dir, args[at + 1] as string) : dir;
    });
    const rest = shellArgs(args.slice(i + 1));
    let resolved = false;
    for (const dir of dirs) {
      const alias = gitAlias(dir, sub.text);
      if (alias === undefined) continue;
      resolved = true;
      const script = alias.startsWith("!")
        ? `cd ${shellArgs([aliasDirectory(dir)])} && ${alias.slice(1)} ${rest}`
        : `git -C ${shellArgs([dir])} ${alias} ${rest}`;
      const nested: Context = { ...context, cwds: new Set([dir]), words: [], assigned: [] };
      analyzeScript(script, nested, rules, depth + 1);
    }
    if (resolved) return;
  }
  if (!sub?.literal || !KNOWN_GIT.has(sub.text)) opaque = opaque || !!sub;
  if (opaque) {
    // A literal `git` with an unknown subcommand could be anything Git runs: any forcing or
    // deleting flag is enough. An unknown program needs the subcommand's name somewhere too.
    opaqueGitRules([...segment.flatMap(split), ...context.assigned], !program.literal, rules);
    return;
  }
  if (!sub) return;
  // A push whose options are only known at run time (`$ARGS`, `${F:- -f}`, `$(echo -f)`), or
  // that a `remote.*`/`push.*` setting configures, could be forced.
  if (sub.text === "push" && (pushConfig || cmd.args.slice(i + 1).some((word) => word.bare)))
    rules.add("force-push");
  gitRules(sub.text, args.slice(i + 1), rules);
}

/**
 * The hard rules the command's text names, read as plain words after removing quotes and
 * backslashes. This catches commands the scanner reads as data but that still run: a script
 * piped into a shell, `bash <(...)`, `find -exec`, inline interpreter code, a shell alias. Linear
 * time: splitting only, no backtracking pattern.
 */
function textRules(script: string, cwd: string, rules: Set<HardRule>): void {
  const stripped = script.replace(/['"\\]/g, "");
  const cwds = new Set(cwd ? [cwd] : []);
  for (const segment of stripped.split(/[;&|\n()`<>]/)) {
    const tokens = segment.split(/[\s,]+/).filter(Boolean);
    tokens.forEach((token, k) => {
      const word = token.slice(token.lastIndexOf("=") + 1);
      if (word) {
        pathRules(word, rules, false);
        for (const path of resolutions(word, cwds)) pathRules(path, rules, false);
      }
      if (word.split("/").pop() !== "git") return;
      let j = k + 1;
      while (tokens[j]?.startsWith("-")) j += GIT_VALUED.has(tokens[j] as string) ? 2 : 1;
      const sub = tokens[j];
      if (sub && KNOWN_GIT.has(sub)) gitRules(sub, tokens.slice(j + 1), rules);
    });
  }
}

/** The hard rules a shell script falls under, judged in its working directory. */
export function scriptRules(script: string, cwd: string): Set<HardRule> {
  const rules = new Set<HardRule>();
  const context: Context = {
    cwds: new Set(cwd ? [cwd] : []),
    unknownCwd: !cwd,
    words: [],
    assigned: [],
  };
  analyzeScript(script, context, rules, 0);
  return rules;
}

/** The hard rules a request falls under, from what it touches. */
function requestRules(request: Request, rules: Set<HardRule>): void {
  const input = request.input;
  const cwds = new Set(request.cwd ? [request.cwd] : []);
  const file = (path: string, write: boolean) => {
    for (const target of [path, ...resolutions(path, cwds)]) {
      if (write) pathRules(target, rules, false);
      if (sensitive(slashes(target))) rules.add("credential-read");
    }
  };
  if (WRITE_TOOLS.has(request.tool) || ["Read", "view", "read_file"].includes(request.tool)) {
    const path = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof path === "string") file(path, WRITE_TOOLS.has(request.tool));
    return;
  }
  if (request.tool === "apply_patch") {
    const patch = input.command ?? input.patch ?? input.input;
    if (typeof patch !== "string") return;
    for (const line of patch.split("\n"))
      if (/^\*\*\* (?:Add File|Update File|Delete File|Move to): /.test(line))
        file(line.slice(line.indexOf(": ") + 2).trim(), true);
    return;
  }
  const script = input.command ?? input.cmd;
  if (SHELL_TOOLS.has(request.tool) && typeof script === "string") {
    for (const rule of scriptRules(script, request.cwd)) rules.add(rule);
    // The union with the plain-text reading: either one naming a hard rule makes it hard.
    textRules(script, request.cwd, rules);
  }
}

/** Every hard rule a decision that needs a person falls under, built-in guards first. */
export function hardRules(request: Request, decision: Decision): HardRule[] {
  const rules = new Set<HardRule>();
  if (decision.userOnly || decision.reason === APPROVE_GUARD) rules.add("self-approve");
  if (FOREIGN_RECORD_REASON.test(decision.reason)) rules.add("foreign-classification-record");
  for (const [pattern, rule] of REASON_RULES) if (pattern.test(decision.reason)) rules.add(rule);
  requestRules(request, rules);
  if (decision.category === "sensitive" && !rules.size) rules.add("protected");
  return [...rules];
}

/** The first hard rule a decision that needs a person falls under, or undefined. */
export function hardRule(request: Request, decision: Decision): HardRule | undefined {
  if (decision.decision !== "human") return undefined;
  return hardRules(request, decision)[0];
}
