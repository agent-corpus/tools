import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonical, git, inside, resolveWord, sensitive, tempRoots } from "./evidence.js";
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
  /**
   * The deterministic floor under the classifier: cloud and infrastructure writes and deletes
   * (az, aws, gcloud, kubectl, helm, terraform, pulumi...), GitHub repository, release and secret
   * deletion, package publishing, and a recursive `rm` outside a linked feature worktree, the
   * temp directory and the profile's scratch roots. None of these is provably recoverable.
   */
  "cloud-write",
  "repo-delete",
  "publish",
  "rm-outside",
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
const FOREIGN_RECORD_REASON = /^A classification record/;

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
/** A cloud CLI word that marks a read: anything without one is treated as a write. */
const CLOUD_READ_VERB =
  /^(?:list(?:-.*)?|show(?:-.*)?|get(?:-.*)?|describe(?:-.*)?|query|search|wait|exists|version|ls|tail|help|whoami|login|logout|status)$/;
const INFRA_WRITE: Record<string, RegExp> = {
  kubectl:
    /^(?:apply|create|delete|replace|patch|edit|scale|autoscale|rollout|set|label|annotate|drain|cordon|uncordon|taint|expose|run|exec|cp|attach)$/,
  oc: /^(?:apply|create|delete|replace|patch|edit|scale|rollout|set|label|annotate|expose|run|exec|new-app|start-build)$/,
  helm: /^(?:install|upgrade|uninstall|delete|rollback|push)$/,
  terraform: /^(?:apply|destroy|import|taint|untaint|state|force-unlock|workspace)$/,
  tofu: /^(?:apply|destroy|import|taint|untaint|state|force-unlock|workspace)$/,
  terragrunt: /^(?:apply|destroy|import|taint|untaint|state|force-unlock|run-all)$/,
  pulumi: /^(?:up|update|destroy|refresh|import|state|cancel|stack)$/,
  eksctl: /^(?:create|delete|upgrade|scale|set|unset|drain)$/,
};
const PUBLISHERS: Record<string, RegExp> = {
  npm: /^(?:publish|unpublish|deprecate|dist-tag)$/,
  pnpm: /^publish$/,
  yarn: /^(?:publish|npm)$/,
  cargo: /^(?:publish|yank|owner)$/,
  twine: /^upload$/,
  gem: /^(?:push|yank)$/,
  poetry: /^publish$/,
  docker: /^push$/,
  podman: /^push$/,
};
const GH_DELETE: Record<string, RegExp> = {
  repo: /^(?:delete|archive|rename|edit)$/,
  release: /^(?:delete|delete-asset)$/,
  secret: /^(?:delete|remove|set)$/,
  variable: /^(?:delete|set)$/,
};

/** The floor rules for one literal program. */
function floorRules(name: string, cmd: Command, context: Context, rules: Set<HardRule>): void {
  const positional = cmd.args.filter((word) => !word.text.startsWith("-"));
  const first = positional[0]?.text ?? "";
  if (INFRA_WRITE[name]?.test(first)) rules.add("cloud-write");
  if (name === "dotnet" && first === "nuget" && positional[1]?.text === "push")
    rules.add("publish");
  else if (PUBLISHERS[name]?.test(first)) rules.add("publish");
  if (name === "gh") {
    if (GH_DELETE[first]?.test(positional[1]?.text ?? "")) rules.add("repo-delete");
    const method = cmd.args.findIndex((word) => /^(?:-X|--method)$/.test(word.text));
    const value =
      method >= 0
        ? cmd.args[method + 1]?.text
        : cmd.args
            .find((word) => /^(?:-X|--method=)/.test(word.text))
            ?.text.replace(/^(?:-X|--method=)/, "");
    if (first === "api" && /^delete$/i.test(value ?? "")) rules.add("repo-delete");
    // Any other method than GET, or a field (which makes gh send a POST), writes.
    const fields = cmd.args.some((word) =>
      /^(?:-[fF]|--(?:field|raw-field|input)(?:=|$))/.test(word.text),
    );
    if (first === "api" && (value !== undefined ? !/^(?:get|head)$/i.test(value) : fields))
      rules.add("cloud-write");
  }
  if (
    httpWrite(
      name,
      cmd.args.map((word) => word.text),
    )
  )
    rules.add("cloud-write");
  if (name === "find") {
    const texts = cmd.args.map((word) => word.text);
    const exec = texts.findIndex((text) => /^-(?:exec|execdir|ok|okdir)$/.test(text));
    const deletes =
      texts.includes("-delete") ||
      (exec >= 0 && /^(?:.*\/)?(?:rm|rmdir|unlink|shred)$/.test(texts[exec + 1] ?? ""));
    if (deletes) {
      const start = cmd.args.findIndex((word) => /^[-!(]/.test(word.text));
      const roots = cmd.args.slice(0, start < 0 ? cmd.args.length : start);
      const targets = roots.length ? roots : [{ text: ".", literal: true } as Word];
      if (targets.some((word) => !disposableTarget(word, context))) rules.add("rm-outside");
    }
  }
  if (name === "rm" && cmd.args.some((word) => /^-[a-zA-Z]*[rR]|^--recursive$/.test(word.text)))
    for (const word of cmd.args) {
      if (word.text.startsWith("-") && word.literal) continue;
      if (!disposableTarget(word, context)) rules.add("rm-outside");
    }
}

/**
 * Whether a recursive `rm` target is strictly inside a linked feature worktree, the system temp
 * directory or a profile scratch root. A word that is not literal, or that expands (a glob or a
 * brace) under the home directory, is not.
 */
function disposableTarget(word: Word, context: Context): boolean {
  if (!word.literal) return false;
  const text = word.text;
  const expands = /[*?[{]/.test(text);
  const base = expands ? text.slice(0, text.search(/[*?[{]/)) : text;
  if (expands && (base === "" || base === "~" || base.startsWith("~/") || base === "/")) {
    // `rm -rf ~/{a,b}` or `rm -rf ~/*`: an expansion in the home directory is never disposable.
    if (base.startsWith("~") || base === "/" || base === "") return false;
  }
  if (context.unknownCwd && !base.startsWith("/") && !base.startsWith("~")) return false;
  const roots = [...tempRoots(), ...context.scratchRoots];
  for (const path of resolutions(base || ".", context.cwds)) {
    let real = path;
    try {
      real = canonical(path);
    } catch {
      /* judged as written */
    }
    if (expands && inside(homedir(), real) && !roots.some((root) => inside(root, real)))
      return false;
    const strictly = roots.some((root) => inside(root, real) && real !== root);
    if (!strictly && !featureWorktree(real)) return false;
  }
  return true;
}

/** Whether a path is strictly inside a linked worktree on a feature branch. */
function featureWorktree(path: string): boolean {
  try {
    let dir = path;
    while (!existsSync(dir)) dir = dirname(dir);
    const top = canonical(git(dir, ["rev-parse", "--show-toplevel"]));
    if (!inside(top, path) || top === path) return false;
    const gitDir = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const branch = git(dir, ["branch", "--show-current"]);
    return gitDir !== common && !!branch && !/^(?:main|master)$/.test(branch);
  } catch {
    return false;
  }
}
const SECRET_WORD =
  /(?:secret|credential|password|connection[-_]?strings?|(?:^|[-_])keys?(?:$|[-_])|listKeys|access-token|get-token|kubeconfig)/i;

interface Context {
  cwds: Set<string>;
  unknownCwd: boolean;
  /** Every word of the script and of the scripts it runs, for scripts that cannot be read. */
  words: string[];
  /** The words of every assignment's value, which an expansion can bring into a command. */
  assigned: string[];
  /** The script runs text as code somewhere (a shell, an interpreter, `eval`, `xargs`...). */
  runsText?: boolean;
  /** Absolute directories where a recursive rm is disposable (the profile's scratch roots). */
  scratchRoots: string[];
}

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "source", "."]);
/** Programs that run text they are given (inline code, a here-document, standard input). */
const INTERPRETERS = new Set([
  ...["node", "nodejs", "deno", "bun", "python", "python2", "python3", "perl", "ruby", "php"],
  ...["osascript", "pwsh", "powershell", "lua", "tclsh", "expect"],
  ...["jshell", "irb", "R", "Rscript", "julia", "swift", "groovy", "scala"],
]);
/** Programs that run another command from their arguments or input. */
const RUNNERS = new Set([
  ...["eval", "exec", "xargs", "find", "alias", "ssh", "su", "script", "watch", "parallel"],
  ...["tmux", "screen", "docker", "podman", "kubectl", "nohup", "env", "sudo", "doas"],
]);
/** Whether a command (after wrappers) can run text as code. Unknown programs count. */
export function runsText(cmd: Command): boolean {
  const program = cmd.program;
  if (!program) return false;
  if (!program.literal) return true;
  const name = (program.text.split(/[\\/]/).pop() ?? "").replace(/\d+(?:\.\d+)*$/, "");
  const texts = cmd.args.map((word) => word.text);
  // sed runs a command only through GNU `e` (a command or an `s///e` flag); awk through
  // `system(`, a pipe to or from a command, or `|&`. An ordinary edit or print is data.
  if (name === "sed")
    return texts.some((text) =>
      /(?:^|[;\n{}]\s*)e(?:\s|$)|\/[gpIiMm0-9w]*e[gpIiMm0-9]*\s*(?:$|[;}])/.test(text),
    );
  if (["awk", "gawk", "mawk", "nawk"].includes(name))
    return texts.some((text) => /system\s*\(|\|\s*getline|print[^;]*\|\s*"|\|&/.test(text));
  return (
    SHELL_NAMES.has(name) ||
    INTERPRETERS.has(name) ||
    INTERPRETERS.has(program.text.split(/[\\/]/).pop() ?? "") ||
    RUNNERS.has(name)
  );
}
/** Whether any command of a script can run text as code, or the script could not be read. */
export function scriptRunsText(script: string): boolean {
  const { segments, complete } = scan(script);
  return !complete || segments.some((segment) => runsText(command(segment)));
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
  // Here-document bodies are data unless something in the script runs text as code.
  const runs = !complete || segments.some((segment) => runsText(command(segment)));
  if (runs) context.runsText = true;
  for (const segment of segments)
    for (const word of segment) {
      if (word.heredoc) continue;
      context.words.push(...split(word));
      if (/^[A-Za-z_]\w*\+?=/.test(word.text)) context.assigned.push(...split(word));
    }
  // A script the scanner could not read fully is judged on its words alone.
  if (!complete) opaqueGitRules(context.words, true, rules);
  for (const segment of segments) {
    analyzeCommand(command(segment), segment, context, rules, depth);
    // A here-document fed to a shell, or in a script that runs text (`cat <<EOF | sh`), is code.
    for (const doc of segment.filter((word) => word.heredoc))
      if (runs && depth < 4) {
        analyzeScript(doc.text, context, rules, depth + 1);
        textRules(doc.text, [...context.cwds][0] ?? "", rules);
      }
  }
}

function analyzeCommand(
  cmd: Command,
  segment: Word[],
  context: Context,
  rules: Set<HardRule>,
  depth: number,
): void {
  // Every word could name a file: arguments, redirect targets, assignment values. A here-document
  // body, and an argument with whitespace in it (a message, a PR body), is text, not a path,
  // unless the script runs text as code.
  for (const word of segment) {
    if (word.heredoc) continue;
    if (!word.redirect && !context.runsText && /\s/.test(word.text)) continue;
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
    else if (!args.some((arg) => CLOUD_READ_VERB.test(arg)) && !cloudGet(args))
      rules.add("cloud-write");
    return;
  }
  if (program.literal) floorRules(name, cmd, context, rules);
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
export function scriptRules(
  script: string,
  cwd: string,
  scratchRoots: string[] = [],
): Set<HardRule> {
  const rules = new Set<HardRule>();
  const context: Context = {
    cwds: new Set(cwd ? [cwd] : []),
    unknownCwd: !cwd,
    words: [],
    assigned: [],
    scratchRoots,
  };
  analyzeScript(script, context, rules, 0);
  return rules;
}

/** The hard rules a request falls under, from what it touches. */
function requestRules(request: Request, rules: Set<HardRule>, scratchRoots: string[]): void {
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
    for (const rule of scriptRules(script, request.cwd, scratchRoots)) rules.add(rule);
    // The union with the plain-text reading, which catches code the scanner reads as data (a
    // script piped into a shell, inline interpreter code). Only when something runs text: in a
    // script that does not, quoted text and here-documents are data (a commit message, a PR body).
    if (scriptRunsText(script)) textRules(script, request.cwd, rules);
  }
}

/** Every hard rule a decision that needs a person falls under, built-in guards first. */
export function hardRules(
  request: Request,
  decision: Decision,
  scratchRoots: string[] = [],
): HardRule[] {
  const rules = new Set<HardRule>();
  if (decision.userOnly || decision.reason === APPROVE_GUARD) rules.add("self-approve");
  if (FOREIGN_RECORD_REASON.test(decision.reason)) rules.add("foreign-classification-record");
  for (const [pattern, rule] of REASON_RULES) if (pattern.test(decision.reason)) rules.add(rule);
  requestRules(request, rules, scratchRoots);
  if (decision.category === "sensitive" && !rules.size) rules.add("protected");
  return [...rules];
}

/** The first hard rule a decision that needs a person falls under, or undefined. */
export function hardRule(
  request: Request,
  decision: Decision,
  scratchRoots: string[] = [],
): HardRule | undefined {
  if (decision.decision !== "human") return undefined;
  return hardRules(request, decision, scratchRoots)[0];
}

/**
 * `az rest` and `az devops invoke` send a GET unless a method says otherwise: with no method, or
 * `GET`/`HEAD`, they read.
 */
function cloudGet(args: string[]): boolean {
  const generic =
    (args[0] === "rest" ? 1 : 0) || (args[0] === "devops" && args[1] === "invoke" ? 2 : 0);
  if (!generic) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const named = /^(?:--method|-m|--http-method)$/.test(arg)
      ? args[i + 1]
      : /^(?:--method|--http-method)=/.test(arg)
        ? arg.slice(arg.indexOf("=") + 1)
        : undefined;
    if (named !== undefined && !/^(?:get|head)$/i.test(named)) return false;
  }
  return true;
}

const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)(?::\d+)?$/i;
/** The hosts of the URLs among `args`, and whether any is not loopback. */
function remoteUrl(args: string[]): boolean {
  return args.some((arg) => {
    const match = /^(?:https?:\/\/)([^/?#\s]+)/i.exec(arg);
    return !!match && !LOOPBACK.test((match[1] ?? "").replace(/^[^@]*@/, ""));
  });
}
/**
 * An HTTP client sending anything but GET or HEAD to a host that is not loopback: curl (`-X`,
 * `--request`, data or form options imply POST, `-T` a PUT, `-G` forces GET), wget (`--method`,
 * `--post-*`, `--body-*`), httpie (`http`/`https` with a write method or data items), and
 * PowerShell's `Invoke-RestMethod`/`Invoke-WebRequest` (`-Method`, `-Body`).
 */
function httpWrite(name: string, args: string[]): boolean {
  const lower = name.toLowerCase();
  let method: string | undefined;
  let body = false;
  if (name === "curl") {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === "-X" || arg === "--request") method = args[++i];
      else if (/^-X./.test(arg)) method = arg.slice(2);
      else if (arg.startsWith("--request=")) method = arg.slice(10);
      else if (
        /^(?:-d|-F|--data|--data-\w+|--json|--form|--form-string)(?:=|$)/.test(arg) ||
        /^-[dF]./.test(arg)
      )
        body = true;
      else if (arg === "-T" || arg.startsWith("--upload-file")) method = method ?? "PUT";
      else if (arg === "-G" || arg === "--get") method = "GET";
    }
  } else if (name === "wget") {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === "--method") method = args[++i];
      else if (arg.startsWith("--method=")) method = arg.slice(9);
      else if (/^--(?:post|body)-(?:data|file)/.test(arg)) body = true;
    }
  } else if (name === "http" || name === "https" || name === "xh") {
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (/^[A-Z]+$/.test(positional[0] ?? "")) method = positional[0];
    else if (
      positional
        .slice(1)
        .some((item) => /^[^=:@]+(?::=|==?|@)/.test(item) && !/^[^=]+==/.test(item))
    )
      body = true;
  } else if (["invoke-restmethod", "invoke-webrequest", "irm", "iwr"].includes(lower)) {
    for (let i = 0; i < args.length; i++) {
      const arg = (args[i] as string).toLowerCase();
      if (arg === "-method") method = args[++i];
      else if (arg === "-body" || arg === "-infile") body = true;
    }
  } else return false;
  const effective = (method ?? (body ? "POST" : "GET")).toUpperCase();
  return !["GET", "HEAD", "OPTIONS"].includes(effective) && remoteUrl(args);
}
