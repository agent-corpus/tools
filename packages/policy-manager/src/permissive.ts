import { basename, resolve } from "node:path";
import {
  branchEvidence,
  canonical,
  disposable,
  inside,
  isProtectedPath,
  OUTSIDE_REPOSITORY,
  pathEvidence,
  policyState,
  protectedPath,
  resolveWord,
  sensitive,
  tempRoots,
  tempWrite,
} from "./evidence.js";
import { commandDecision } from "./flow.js";
import { mergedEvidence, remoteTipMatches } from "./merged.js";
import { evaluateArgv, result } from "./policy.js";
import type { Profile } from "./profile.js";
import { type Redirect, type SimpleCommand, SUBSTITUTION } from "./shell.js";
import type { Decision, Request } from "./types.js";

/**
 * Permissive profile: approve everything except effects that are destructive, irreversible,
 * outward-facing, or touch credentials and protected configuration. The default for anything not
 * recognised as dangerous is approval, so the deny side below is the policy. Each simple command
 * of a compound command is judged separately and the first refusal decides.
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "php", "deno", "bun"]);
const DESTRUCTIVE = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "srm",
  "sudo",
  "su",
  "doas",
  "dd",
  "mkfs",
  "diskutil",
  "fdisk",
  "truncate",
  "eval",
  "source",
  ".",
  "exec",
  "crontab",
  "launchctl",
  "systemctl",
  "pushd",
  "popd",
]);
const WRITERS = new Set([
  "mv",
  "cp",
  "mkdir",
  "touch",
  "tee",
  "ln",
  "install",
  "rsync",
  "chmod",
  "chown",
]);
const WRAPPERS = new Set(["env", "nohup", "time", "command", "nice", "timeout", "xargs"]);
/**
 * Programs whose behaviour cannot be changed by an unknown argument: they only print or compare
 * strings. The output of a command substitution may be an argument of these and of nothing else,
 * because for any other program it could be a flag, a path or a subcommand the checks never saw.
 */
const SUBSTITUTION_OK = new Set([
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "basename",
  "dirname",
]);
// Variables that change how later commands are found, split or started. Assigning one, as a prefix
// or on its own, needs a human.
export const BANNED_ENV =
  /^(?:LD_|DYLD_|GIT_|PYTHON|NODE_OPTIONS$|PATH$|HOME$|BASH_ENV$|ENV$|SHELL$|PAGER$|EDITOR$|GH_TOKEN$|GITHUB_TOKEN$|IFS$|PS4$|PROMPT_COMMAND$|CDPATH$|GLOBIGNORE$|BASHOPTS$|SHELLOPTS$|BASH_XTRACEFD$|FPATH$|ZDOTDIR$|BASH_FUNC_|path$|cdpath$|fpath$|manpath$|module_path$)/;
// zsh ties the lowercase arrays path, cdpath, fpath, manpath and module_path to PATH, CDPATH, FPATH,
// MANPATH and MODULE_PATH, so those names are covered too (they are matched case-sensitively).
/** Runs arbitrary statements on another machine or database, so its argument is not judged. */
const REMOTE_EXECUTORS = new Set([
  "ssh",
  "psql",
  "mysql",
  "mariadb",
  "sqlite3",
  "sqlcmd",
  "mongo",
  "mongosh",
  "redis-cli",
  "cqlsh",
  "sqlplus",
]);
/** Builtins that run a string later or change how later commands behave. */
const STATE_BUILTINS = new Set([
  "trap",
  "alias",
  "unalias",
  "builtin",
  "enable",
  "declare",
  "typeset",
  "local",
  "readonly",
  "let",
  "mapfile",
  "readarray",
  "getopts",
  "coproc",
  "fc",
  "history",
  "hash",
  // builtins that store into a variable the evaluator tracks, or run a command through a module
  "vared",
  "zparseopts",
  "r",
  "zformat",
  "zstyle",
  "zregexparse",
  "getln",
  "compgen",
  "sysread",
  "zselect",
  "ztcp",
  "zpty",
  "setopt",
  "unsetopt",
  "shopt",
  // zsh precommand modifiers and builtins that run a command or string
  "noglob",
  "nocorrect",
  "repeat",
  "emulate",
  "sched",
  "zmodload",
  "autoload",
  "integer",
  "float",
  "functions",
  "-",
]);
/**
 * Options whose next word is a value, not a flag or path, so an unknown (but single, quoted) word
 * there cannot change what the command does: commit and PR messages built with `$(cat <<EOF ...)`.
 */
const VALUE_OPTIONS: Record<string, Record<string, string[]>> = {
  git: {
    commit: ["-m", "--message"],
    tag: ["-m", "--message"],
    stash: ["-m", "--message"],
  },
  gh: {
    "pr create": ["--title", "-t", "--body", "-b"],
    "pr edit": ["--title", "-t", "--body", "-b"],
    "pr comment": ["--body", "-b"],
    "pr review": ["--body", "-b"],
    "issue create": ["--title", "-t", "--body", "-b"],
    "issue edit": ["--title", "-t", "--body", "-b"],
    "issue comment": ["--body", "-b"],
  },
};
const FORCE_PUSH = ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--prune"];

export function human(request: Request, category: Decision["category"], reason: string): Decision {
  return result(request, category, reason);
}

const GH_TEXT = new Set(["--body", "-b", "--title", "-t", "--jq", "-q", "--template", "--notes"]);
/** Short options that take a value, per program; the value is never the pattern or script. */
const SHORT_VALUES: Record<string, string> = {
  sed: "fl",
  grep: "ABCDdfm",
  egrep: "ABCDdfm",
  fgrep: "ABCDdfm",
  rg: "ABCEfgjMmrTt",
};
const GREP_LONG_VALUES = [
  "--after-context",
  "--before-context",
  "--binary-files",
  "--context",
  "--devices",
  "--directories",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--file",
  "--include",
  "--label",
  "--max-count",
];
const GREP_LONG_FLAGS = [
  "--count",
  "--extended-regexp",
  "--files-with-matches",
  "--files-without-match",
  "--fixed-strings",
  "--ignore-case",
  "--invert-match",
  "--line-number",
  "--line-regexp",
  "--no-filename",
  "--no-messages",
  "--null",
  "--only-matching",
  "--perl-regexp",
  "--quiet",
  "--recursive",
  "--dereference-recursive",
  "--silent",
  "--with-filename",
  "--word-regexp",
];
/** Long options that take a separate value; the value is never the pattern or script. */
const LONG_VALUES: Record<string, Set<string>> = {
  sed: new Set(["--file", "--line-length"]),
  grep: new Set(GREP_LONG_VALUES),
  egrep: new Set(GREP_LONG_VALUES),
  fgrep: new Set(GREP_LONG_VALUES),
  rg: new Set([
    "--after-context",
    "--before-context",
    "--context",
    "--encoding",
    "--file",
    "--glob",
    "--iglob",
    "--ignore-file",
    "--max-count",
    "--max-depth",
    "--max-filesize",
    "--pre",
    "--pre-glob",
    "--replace",
    "--sort",
    "--sortr",
    "--threads",
    "--type",
    "--type-add",
    "--type-not",
  ]),
};
/** Long options known to take no value. */
const LONG_FLAGS: Record<string, Set<string>> = {
  sed: new Set([
    "--debug",
    "--null-data",
    "--posix",
    "--quiet",
    "--regexp-extended",
    "--sandbox",
    "--separate",
    "--silent",
    "--unbuffered",
    "--in-place",
  ]),
  grep: new Set(GREP_LONG_FLAGS),
  egrep: new Set(GREP_LONG_FLAGS),
  fgrep: new Set(GREP_LONG_FLAGS),
  rg: new Set([
    "--count",
    "--files-with-matches",
    "--fixed-strings",
    "--follow",
    "--hidden",
    "--ignore-case",
    "--invert-match",
    "--json",
    "--line-number",
    "--multiline",
    "--no-filename",
    "--no-heading",
    "--no-ignore",
    "--only-matching",
    "--pcre2",
    "--smart-case",
    "--vimgrep",
    "--with-filename",
    "--word-regexp",
  ]),
};

/**
 * File names a sed script reads, writes or runs (`r`, `R`, `w`, `W`, the `s///w` flag, GNU `e`).
 * Over-matching only sends more to a human.
 */
function sedScriptPaths(script: string): string[] {
  const paths: string[] = [];
  for (const match of script.matchAll(/(?:^|[^A-Za-z\\])[eErRwW]\s*([^\n]*)/g))
    paths.push(...(match[1] ?? "").split(/[\s;]+/).filter(Boolean));
  return paths;
}

/**
 * Indices of `args` that are text rather than paths, paths named inside that text, and the file
 * operands (for sed, the files `-i` rewrites).
 */
function textOperands(
  program: string,
  args: string[],
): { text: Set<number>; paths: string[]; files: string[] } {
  const text = new Set<number>();
  const files: string[] = [];
  if (program === "gh") {
    for (const [index, word] of args.entries()) {
      if (GH_TEXT.has(word)) text.add(index + 1);
      else if (/^--(?:body|title|jq|template|notes)=/.test(word)) text.add(index);
    }
    return { text, paths: [], files };
  }
  const values = SHORT_VALUES[program];
  if (values === undefined) return { text, paths: [], files };
  const scripts: string[] = [];
  const named = (index: number, script = args[index] ?? "") => {
    text.add(index);
    scripts.push(script);
  };
  let explicit = false;
  let ended = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index] ?? "";
    if (!ended && word === "--") {
      ended = true;
      continue;
    }
    if (!ended && word.startsWith("-")) {
      if (word === "--expression" || word === "--regexp") {
        explicit = true;
        named(++index);
      } else if (/^--(?:expression|regexp)=/.test(word)) {
        explicit = true;
        named(index, word.slice(word.indexOf("=") + 1));
      } else if (word.startsWith("--")) {
        if (word.includes("=")) continue;
        // A value-taking long option consumes the next word, which stays a checked operand. An
        // option this list does not know might too, so nothing is treated as text.
        if (LONG_VALUES[program]?.has(word)) index++;
        else if (!LONG_FLAGS[program]?.has(word))
          return {
            text: new Set(),
            paths: [],
            files: args.filter((arg) => arg !== "" && !arg.startsWith("-")),
          };
      } else if (/^-[A-Za-z]/.test(word))
        for (let at = 1; at < word.length; at++) {
          const flag = word[at] ?? "";
          if (program === "sed" && flag === "i") break; // the rest is a backup suffix
          if (flag === "e") {
            explicit = true;
            if (at + 1 < word.length) named(index, word.slice(at + 1));
            else named(++index);
            break;
          }
          if (values.includes(flag)) {
            if (at + 1 === word.length) index++;
            break;
          }
        }
      continue;
    }
    // The first operand is the script or pattern unless -e named one. BSD `sed -i ''` leaves an
    // empty suffix operand, which is skipped.
    if (word === "") continue;
    if (!explicit && scripts.length === 0) named(index);
    else files.push(word);
  }
  const paths = program === "sed" ? scripts.flatMap(sedScriptPaths) : [];
  return { text, paths, files };
}

const FIND_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
/**
 * `rm`, `rmdir`, `unlink` or `find ... -delete` whose every target is disposable: strictly inside
 * a scratch root or the system temp directory (see `disposable`).
 */
function scratchDeletion(program: string, args: string[], cwd: string, profile: Profile): boolean {
  const roots = [...profile.scratchRoots, ...tempRoots()];
  let targets: string[];
  if (program === "rm" || program === "rmdir" || program === "unlink") {
    const end = args.indexOf("--");
    const options = end < 0 ? args : args.slice(0, end);
    targets = [
      ...options.filter((arg) => !arg.startsWith("-")),
      ...(end < 0 ? [] : args.slice(end + 1)),
    ];
    // `rmdir -p` also removes empty ancestors, up to and past a root.
    if (program === "rmdir" && options.some((arg) => arg === "--parents" || /^-[^-]*p/.test(arg)))
      return false;
  } else if (program === "find") {
    if (
      !args.includes("-delete") ||
      args.some((arg) => FIND_ACTIONS.has(arg) || ["-follow", "-files0-from"].includes(arg))
    )
      return false;
    // Leading options come before the start paths: GNU -P -D -O, BSD -E -s -x -X -d. -H, -L follow
    // symlinks and BSD -f names a start path, so those stay with a person.
    let index = 0;
    for (; index < args.length; index++) {
      const arg = args[index] ?? "";
      if (arg === "--") {
        index++;
        break;
      }
      if (/^-[PEsxXd]$/.test(arg) || /^-O[0-9]*$/.test(arg)) continue;
      if (arg === "-D") {
        index++;
        continue;
      }
      // Expression primaries are words (-name, -type); a single letter is an unknown option.
      if (/^-[HLf]$/.test(arg) || /^-.$/.test(arg)) return false;
      break;
    }
    targets = [];
    for (; index < args.length && !/^[-(!)]/.test(args[index] ?? ""); index++)
      targets.push(args[index] as string);
    if (targets.length === 0) targets = ["."];
  } else return false;
  return targets.length > 0 && targets.every((target) => disposable(cwd, target, roots));
}

export function permissiveRead(cwd: string, input: string) {
  try {
    const lexical = resolveWord(cwd, input);
    const path = canonical(lexical);
    if (sensitive(path) || sensitive(lexical))
      return {
        allowed: false,
        category: "sensitive" as const,
        reason: "Protected path requires human approval",
      };
    return {
      allowed: true,
      category: "code-read" as const,
      reason: "Read of a non-sensitive path",
    };
  } catch {
    return {
      allowed: false,
      category: "code-read" as const,
      reason: "Cannot verify path evidence",
    };
  }
}

export function permissiveWrite(cwd: string, input: string, profile: Profile) {
  let lexical: string | undefined;
  let path: string | undefined;
  try {
    lexical = resolveWord(cwd, input);
    path = canonical(lexical);
    if (sensitive(path) || sensitive(lexical) || isProtectedPath(path) || isProtectedPath(lexical))
      return {
        allowed: false,
        category: "sensitive" as const,
        reason: "Protected path requires human approval",
      };
    // Never let a scratch root reach the policy service's own session directories.
    const target = path;
    if (
      !policyState(target) &&
      !policyState(lexical) &&
      profile.scratchRoots.some((root) => inside(root, target))
    )
      return {
        allowed: true,
        category: "worktree-write" as const,
        reason: "Write within a scratch directory",
      };
  } catch {
    /* fall through to the repository check, which fails closed */
  }
  const evidence = pathEvidence(cwd, input, true);
  // Repository rules win; the temp directory only covers writes outside any repository.
  if (
    !evidence.allowed &&
    evidence.reason === OUTSIDE_REPOSITORY &&
    lexical &&
    path &&
    tempWrite(lexical, path)
  )
    return {
      allowed: true,
      category: "temp-write" as const,
      reason: "Write within the system temp directory",
    };
  return evidence;
}

interface Unwrapped {
  argv: string[];
  /** Assignments given to `env`, which the parser does not see as shell assignments. */
  env: string[];
  refusal?: string;
}

export function unwrap(argv: string[]): Unwrapped {
  let current = argv;
  const env: string[] = [];
  for (let depth = 0; depth < 4; depth++) {
    const program = basename(current[0] ?? "");
    if (!WRAPPERS.has(program) || program === "xargs") return { argv: current, env };
    let rest = current.slice(1);
    while (
      rest[0]?.startsWith("-") ||
      // `env` treats any word with a non-empty name before `=` as an assignment (`A+=1`, `A[0]=1`).
      (program === "env" && /^[^=-][^=]*=/.test(rest[0] ?? "")) ||
      (program === "timeout" && /^[0-9.]+[smhd]?$/.test(rest[0] ?? "")) ||
      (program === "nice" && /^[0-9-]+$/.test(rest[0] ?? ""))
    ) {
      const word = rest[0] ?? "";
      // env options can change the program searched for, the directory or the environment.
      if (program === "env" && word.startsWith("-") && word !== "-i" && word !== "--")
        return { argv: current, env, refusal: "env options require human review" };
      if (program === "env" && !word.startsWith("-")) env.push(word.slice(0, word.indexOf("=")));
      rest = rest.slice(1);
    }
    if (!rest.length) return { argv: current, env };
    current = rest;
  }
  return { argv: current, env };
}

/** True when `flag` is `name` or a unique-looking abbreviation Git's option parser would accept. */
function abbreviates(flag: string, name: string): boolean {
  if (!flag.startsWith("--") || !name.startsWith("--")) return flag === name;
  const given = flag.split("=")[0] as string;
  return given.length > 2 && name.startsWith(given);
}

const SAFE_CONFIG_KEYS =
  /^(?:core\.(?:bare|filemode|autocrlf|longpaths|ignorecase|precomposeunicode|untrackedcache)|user\.(?:name|email)|push\.(?:default|autosetupremote|followtags)|pull\.(?:rebase|ff)|fetch\.prune|merge\.ff|rebase\.autostash|rerere\.enabled|init\.defaultbranch|branch\.[A-Za-z0-9/_.-]+\.(?:remote|merge|rebase)|advice\.[a-z]+|color\.[a-z.]+)$/i;

/** Only local, non-executable settings; hooks, aliases, credential helpers and URLs need a human. */
function safeConfigWrite(rest: string[]): boolean {
  const flags = rest.filter((word) => word.startsWith("-"));
  if (flags.some((flag) => !["--local", "--worktree", "--unset", "--bool", "--int"].includes(flag)))
    return false;
  const words = rest.filter((word) => !word.startsWith("-"));
  return words.length >= 1 && words.length <= 2 && SAFE_CONFIG_KEYS.test(words[0] ?? "");
}

function gitDecision(request: Request, argv: string[], cwdForGit: string): Decision {
  const args = argv.slice(1);
  let index = 0;
  let cwd = cwdForGit;
  while (index < args.length && args[index]?.startsWith("-")) {
    if (args[index] === "-C" && args[index + 1]) {
      cwd = resolve(cwd, args[index + 1] as string);
      index += 2;
    } else if (args[index] === "--no-pager" || args[index] === "-P") index++;
    else return human(request, "unknown", "Git global option requires human review");
  }
  const sub = args[index];
  const rest = args.slice(index + 1);
  const flags = rest.filter((word) => word.startsWith("-"));
  const positional = rest.filter((word) => !word.startsWith("-"));
  const has = (...names: string[]) =>
    flags.some((flag) => names.some((name) => abbreviates(flag, name)));
  const cluster = (letter: string) =>
    flags.some((flag) => /^-[a-zA-Z]+$/.test(flag) && flag.includes(letter));
  const ok = (reason = "Permissive profile: Git operation has no destructive effect") =>
    result(request, "impactful-write", reason, true);
  if (!sub) return ok();
  if (sub === "push") return gitPush(request, cwd, rest);
  if (sub === "branch" && (has("-d", "-D", "--delete") || cluster("d") || cluster("D"))) {
    if (has("-r", "--remotes")) return ok();
    const unmerged = positional.filter((name) => !mergedEvidence(cwd, `refs/heads/${name}`).merged);
    return unmerged.length
      ? human(request, "destructive", branchEvidence(cwd, unmerged[0] ?? ""))
      : ok("Branch is already merged into origin's default branch");
  }
  if (sub === "branch" && (has("-f", "--force") || cluster("f") || has("-M")))
    return human(request, "destructive", "Forced branch move requires human approval");
  if (sub === "reset" && has("--hard"))
    return human(request, "destructive", "git reset --hard discards work");
  if (sub === "clean" && !has("-n", "--dry-run") && !cluster("n"))
    return human(request, "destructive", "git clean deletes untracked files");
  if (
    sub === "checkout" &&
    (has("-f", "--force", "-B") ||
      rest.includes("--") ||
      positional.includes(".") ||
      positional.includes(":/"))
  )
    return human(request, "destructive", "git checkout would discard working-tree changes");
  if (sub === "restore" && (!has("--staged", "-S") || has("--worktree", "-W") || cluster("W")))
    return human(request, "destructive", "git restore would discard working-tree changes");
  if (sub === "switch" && has("-f", "--force", "--discard-changes"))
    return human(request, "destructive", "git switch would discard working-tree changes");
  if (sub === "stash" && ["drop", "clear"].includes(positional[0] ?? ""))
    return human(request, "destructive", "Dropping stashes discards work");
  if (sub === "reflog" && ["expire", "delete"].includes(positional[0] ?? ""))
    return human(request, "destructive", "Reflog expiry removes recovery points");
  if (
    ["gc", "prune", "filter-branch", "filter-repo", "replace"].includes(sub) ||
    (sub === "update-ref" && has("-d"))
  )
    return human(
      request,
      "destructive",
      "Repository history or object pruning requires human approval",
    );
  if (
    sub === "worktree" &&
    ["remove", "prune"].includes(positional[0] ?? "") &&
    (has("-f", "--force") || positional[0] === "prune")
  )
    return human(request, "destructive", "Forced worktree removal requires human approval");
  if (
    sub === "config" &&
    !has("--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin") &&
    !safeConfigWrite(rest)
  )
    return human(request, "sensitive", "Git configuration can install hooks or credential helpers");
  if (
    sub === "remote" &&
    ["set-url", "remove", "rm", "rename", "set-head"].includes(positional[0] ?? "")
  )
    return human(request, "impactful-write", "Changing remotes requires human approval");
  return ok();
}

function gitPush(request: Request, cwd: string, rest: string[]): Decision {
  const flags = rest.filter((word) => word.startsWith("-"));
  const positional = rest.filter((word) => !word.startsWith("-"));
  const optionValues = new Set<string>();
  rest.forEach((word, i) => {
    if (
      (word === "-o" ||
        word === "--push-option" ||
        word === "--receive-pack" ||
        word === "--exec" ||
        word === "--repo") &&
      rest[i + 1]
    )
      optionValues.add(rest[i + 1] as string);
  });
  const refs = positional.filter((word) => !optionValues.has(word));
  const remote = refs[0];
  const refspecs = refs.slice(1);
  if (
    flags.some(
      (flag) =>
        FORCE_PUSH.some((name) => abbreviates(flag, name)) ||
        (/^-[a-zA-Z]+$/.test(flag) && flag.includes("f")),
    )
  )
    return human(request, "destructive", "Force or mirror pushes overwrite remote history");
  if (flags.some((flag) => abbreviates(flag, "--receive-pack") || abbreviates(flag, "--exec")))
    return human(request, "unknown", "Custom push executables require human review");
  const deleting =
    flags.some((flag) => abbreviates(flag, "--delete")) ||
    flags.some((flag) => /^-[a-zA-Z]*d[a-zA-Z]*$/.test(flag));
  const targets: string[] = [];
  for (const spec of refspecs) {
    if (spec.startsWith("+"))
      return human(request, "destructive", "Forced refspecs overwrite remote history");
    if (spec.startsWith(":")) targets.push(spec.slice(1));
    else if (deleting) targets.push(spec);
  }
  if (!targets.length)
    return result(request, "impactful-write", "Permissive profile: push without deletion", true);
  if (remote !== "origin")
    return human(request, "destructive", "Remote branch deletion is only verified for origin");
  for (const target of targets) {
    const name = target.replace(/^refs\/heads\//, "");
    if (target.startsWith("refs/tags/") || !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(name))
      return human(
        request,
        "destructive",
        "Only branch deletions with verified merge state are automatic",
      );
    const evidence = mergedEvidence(cwd, `refs/remotes/origin/${name}`);
    if (!evidence.merged)
      return human(request, "destructive", `Remote branch deletion may lose work: ${evidence.how}`);
    if (!remoteTipMatches(cwd, name))
      return human(
        request,
        "destructive",
        "Remote branch has commits that are not fetched; fetch and retry",
      );
  }
  return result(
    request,
    "impactful-write",
    "Deleting remote branch already merged into origin's default branch",
    true,
  );
}

function ghDecision(request: Request, argv: string[]): Decision | undefined {
  const text = argv.join(" ");
  if (argv[1] === "api") {
    const method =
      /(?:^|\s)(?:-X|--method)[=\s]?DELETE\b/i.test(text) || /\s-XDELETE\b/i.test(text);
    if (method || /\/(?:protection|rulesets|keys|secrets|hooks)\b/.test(text))
      return human(request, "destructive", "Destructive or security-sensitive GitHub API call");
  }
  if (
    argv.includes("delete") ||
    (argv[1] === "pr" && argv[2] === "merge" && argv.includes("--admin"))
  )
    return human(request, "destructive", "Destructive GitHub operation requires human approval");
  if (
    argv[1] === "secret" ||
    (argv[1] === "auth" && ["token", "refresh", "logout"].includes(argv[2] ?? ""))
  )
    return human(request, "sensitive", "Credential or secret handling requires human approval");
  return undefined;
}

/**
 * Read-only operations by verb, for services outside the exact catalog. The selectors already
 * passed the credential screen in `evaluateArgv`; endpoint overrides still need a human.
 */
const AWS_METADATA_GETTERS = new Set([
  "get-caller-identity",
  "get-account-summary",
  "get-role",
  "get-user",
  "get-group",
  "get-policy",
  "get-policy-version",
  "get-function-configuration",
  "get-bucket-location",
  "get-bucket-versioning",
  "get-bucket-tagging",
  "get-bucket-policy-status",
  "get-rest-apis",
  "get-resources",
  "get-hosted-zone",
  "get-metric-statistics",
  "get-log-events",
]);

function readVerb(argv: string[]): boolean {
  const [tool] = argv;
  const firstOption = argv.findIndex((arg) => arg.startsWith("-"));
  const operation = (firstOption < 0 ? argv : argv.slice(0, firstOption)).slice(1);
  const verb = operation.at(-1) ?? "";
  if (tool === "gcloud" && /token|secret|password|credential|key/i.test(operation.join(" ")))
    return false;
  if (operation.length < 2 || !operation.every((word) => /^[a-z][a-z0-9-]*$/.test(word)))
    return false;
  if (argv.some((arg) => /^--(?:endpoint|endpoint-url|api-endpoint|debug|profile-file)/.test(arg)))
    return false;
  if (/token|secret|password|credential|key/i.test(verb)) return false;
  if (tool === "az") return /^(?:list|show|exists|list-[a-z-]+|show-[a-z-]+)$/.test(verb);
  if (tool === "aws") {
    // `get-*` is not safe as a family: it includes secret, password, token and access-detail
    // retrieval. Only `describe-`/`list-` and an explicit set of metadata getters are automatic.
    if (argv.some((arg) => /^--(?:no-)?with-decryption/.test(arg))) return false;
    return /^(?:describe|list)-[a-z-]+$/.test(verb) || AWS_METADATA_GETTERS.has(verb);
  }
  if (tool === "gcloud") {
    // gcloud passes the resource as a positional after the verb: `run services describe svc`.
    const at = operation.findIndex((word) => /^(?:list|describe)$/.test(word));
    return at >= 0 && operation.length - at <= 2;
  }
  return false;
}

function cloudDecision(request: Request, argv: string[], profile: Profile): Decision {
  const strict = evaluateArgv(request, argv);
  if (strict.decision === "approve" || strict.category === "sensitive") return strict;
  if (argv.some((arg) => /^(delete|destroy|purge|remove|terminate|deregister)/.test(arg)))
    return human(request, "destructive", "Cloud deletion requires human approval");
  if (readVerb(argv))
    return result(request, "cloud-read", "Permissive profile: cloud read-only verb", true);
  if (profile.cloudWrites === "allow" && strict.category === "impactful-write")
    return result(
      request,
      "impactful-write",
      "Permissive profile: non-destructive cloud change",
      true,
    );
  return strict;
}

/** Judges one redirection's target in `cwd`; undefined means it is acceptable. */
export function redirectDecision(
  request: Request,
  redirect: Redirect,
  profile: Profile,
  cwd: string,
): Decision | undefined {
  if (redirect.target.includes(SUBSTITUTION))
    return human(request, "unknown", "Command substitution in a redirection requires human review");
  // `>& word` duplicates a descriptor only when word is a number or `-`; otherwise it names a file.
  if (
    redirect.target === "/dev/null" ||
    (redirect.op === ">&" && /^(?:[0-9]+|-)$/.test(redirect.target))
  )
    return undefined;
  const check =
    redirect.op === "<"
      ? permissiveRead(cwd, redirect.target)
      : permissiveWrite(cwd, redirect.target, profile);
  return check.allowed ? undefined : human(request, check.category, check.reason);
}

/** printf formats with only %s, %b, %q and %%: no argument is evaluated as arithmetic. */
function printfOnlyPrintsStrings(args: string[]): boolean {
  const rest = args[0] === "-v" ? args.slice(2) : args;
  const format = rest[0] === "--" ? rest[1] : rest[0];
  if (format === undefined) return true;
  if (format.includes(SUBSTITUTION) || format.includes("*")) return false;
  for (const match of format.matchAll(/%[-+ #0-9.]*([A-Za-z%])/g))
    if (!"sbq%".includes(match[1] as string)) return false;
  return true;
}

/** The unknown words of `argv` that sit in a value position (see VALUE_OPTIONS), made literal. */
function withOpaqueValues(argv: string[], loose: boolean[] | undefined): string[] {
  const program = basename(argv[0] ?? "");
  const table = VALUE_OPTIONS[program];
  if (!table) return argv;
  const first = program === "git" ? argv.findIndex((w, i) => i > 0 && !w.startsWith("-")) : 1;
  const key = program === "git" ? (argv[first] ?? "") : `${argv[1] ?? ""} ${argv[2] ?? ""}`;
  const options = table[key];
  if (!options) return argv;
  return argv.map((word, index) => {
    if (index === 0 || !word.includes(SUBSTITUTION) || loose?.[index]) return word;
    const previous = argv[index - 1] ?? "";
    const valueOfPrevious =
      !previous.includes(SUBSTITUTION) &&
      (options.includes(previous) ||
        (program === "git" && key === "commit" && /^-[A-Za-z]*m$/.test(previous)));
    const inline = options.some(
      (option) => option.startsWith("--") && word.startsWith(`${option}=`),
    );
    if (!valueOfPrevious && !(inline && !word.split("=")[0]?.includes(SUBSTITUTION))) return word;
    return word.split(SUBSTITUTION).join("OPAQUE");
  });
}

/**
 * A best-effort scan of code an interpreter is about to run, which this policy cannot otherwise
 * read: deleting files, starting processes, evaluating strings, and touching credential or
 * protected paths. It is a denylist, not a proof, so anything it flags goes to a human.
 */
const DANGEROUS_CODE =
  /\b(?:rmtree|removedirs|unlink|unlinkSync|rmdir|rmdirSync|rmSync|os\.remove|os\.removedirs|shutil\.move|child_process|execSync|spawnSync|spawn|subprocess|os\.system|os\.popen|os\.exec[a-z]*|eval|exec|compile|__import__|importlib|ctypes|socket|urlopen|requests\.(?:post|put|delete|patch)|fetch)\b|\bfs\.rm\b|\bPath\([^)]*\)\.(?:unlink|rmdir)|\brm\s+-/;

function interpreterCodeRefusal(code: string): string | undefined {
  if (DANGEROUS_CODE.test(code))
    return "Interpreter code that deletes files, starts processes or evaluates strings requires human review";
  for (const token of code.split(/[\s"'`()[\]{},;=<>|&]+/))
    if (
      (token.includes("/") || token.startsWith(".")) &&
      (sensitive(token) || protectedPath(token))
    )
      return "Interpreter code that names a protected or credential path requires human review";
  return undefined;
}

export function simpleDecision(
  request: Request,
  command: SimpleCommand,
  profile: Profile,
  depth: number,
  stageIndex: number,
  cwd: string,
): Decision {
  for (const [name] of command.env)
    if (BANNED_ENV.test(name))
      return human(request, "unknown", "Environment override requires human review");
  for (const redirect of command.redirects) {
    const refusal = redirectDecision(request, redirect, profile, cwd);
    if (refusal) return refusal;
  }
  const unwrapped = unwrap(command.argv);
  if (unwrapped.refusal) return human(request, "unknown", unwrapped.refusal);
  for (const name of unwrapped.env)
    if (BANNED_ENV.test(name))
      return human(request, "unknown", "Environment override requires human review");
  const looseAfterWrappers = command.loose?.slice(command.argv.length - unwrapped.argv.length);
  const argv = withOpaqueValues(unwrapped.argv, looseAfterWrappers);
  const program = basename(argv[0] ?? "");
  // Words a wrapper consumed (env assignments, options, durations) are gone from `argv`, but an
  // unquoted substitution in them can still split into extra words and pick a different program.
  if (
    command.argv.slice(0, command.argv.length - argv.length).some((w) => w.includes(SUBSTITUTION))
  )
    return human(
      request,
      "unknown",
      "Command substitution inside a wrapper command requires human review",
    );
  if (
    argv.some((word) => word.includes(SUBSTITUTION)) &&
    (argv[0]?.includes(SUBSTITUTION) || !SUBSTITUTION_OK.has(program))
  )
    return human(
      request,
      "unknown",
      "Command substitution output is only accepted as an argument to echo, printf and similar",
    );
  const args = argv.slice(1);
  // zsh expands `=name` to the path of a command, so `command =rm` runs rm.
  if (argv[0]?.startsWith("=") && argv[0].length > 1)
    return human(request, "unknown", "A command named with = requires human review");
  // `[[` evaluates the operands of -eq, -lt and the like as arithmetic, including the value of a
  // bare variable name, and `a[$(cmd)]` runs the command. Only plain integers are safe.
  // `-v` and `-R` take a variable name, and bash evaluates a subscript in it (`a[$(cmd)]`).
  if (program === "[[" || program === "test" || program === "[")
    for (const [index, word] of args.entries())
      if (
        (word === "-v" || word === "-R") &&
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args[index + 1] ?? "")
      )
        return human(
          request,
          "unknown",
          "A variable test with a subscript or computed name requires human review",
        );
  if (program === "[[")
    for (const [index, word] of args.entries())
      if (/^(?:-eq|-ne|-lt|-le|-gt|-ge)$/.test(word)) {
        const operands = [args[index - 1], args[index + 1]];
        if (operands.some((operand) => operand === undefined || !/^-?[0-9]+$/.test(operand)))
          return human(
            request,
            "unknown",
            "A numeric test with a non-integer operand requires human review",
          );
      }
  // zsh and bash evaluate arithmetic in some builtins' operands, and a name such as `a[$(cmd)]`
  // runs the command. An unknown value is therefore only safe where nothing is evaluated.
  if (argv.some((word) => word.includes(SUBSTITUTION))) {
    if (
      (program === "test" || program === "[") &&
      args.some((word) => /^(?:-eq|-ne|-lt|-le|-gt|-ge|-v|-R)$/.test(word))
    )
      return human(
        request,
        "unknown",
        "An unknown value in a numeric or variable test requires human review",
      );
    if (program === "printf" && !printfOnlyPrintsStrings(args))
      return human(
        request,
        "unknown",
        "An unknown value in a printf with numeric conversions requires human review",
      );
  }
  const joined = argv.join(" ");
  if (profile.humanPatterns.some((pattern) => pattern.test(joined)))
    return human(request, "destructive", "Matches an organization human-approval pattern");
  // Anything that looks like a credential or protected-config path stays with a human. Words in
  // known text positions (sed scripts, grep patterns, gh message text) are not paths, but the
  // files a sed script reads or writes are.
  const operands = textOperands(program, args);
  for (const [index, word] of args.entries()) {
    if (operands.text.has(index)) continue;
    const candidate = word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
    if (candidate.includes("/") || candidate.startsWith(".")) {
      if (sensitive(candidate))
        return human(request, "sensitive", "Protected path requires human approval");
    }
  }
  if (operands.paths.some((path) => sensitive(path)))
    return human(request, "sensitive", "Protected path requires human approval");
  if (scratchDeletion(program, args, cwd, profile))
    return result(request, "temp-write", "Delete within a scratch directory", true);
  if (DESTRUCTIVE.has(program) || program.startsWith("mkfs"))
    return human(request, "destructive", "Destructive operation requires human approval");
  if (REMOTE_EXECUTORS.has(program))
    return human(request, "unknown", "Remote or database command execution requires human review");
  if (STATE_BUILTINS.has(program))
    return human(
      request,
      "unknown",
      "A shell builtin that runs a string later or changes later commands requires human review",
    );
  // These print the whole environment, which can hold credentials.
  if (program === "printenv" || program === "env" || (program === "set" && args.length === 0))
    return human(request, "sensitive", "Printing the environment requires human review");
  // `set -A name values` assigns an array, and `wait -p VAR` assigns a variable.
  if (program === "wait" && args.some((word) => word.startsWith("-")))
    return human(request, "unknown", "wait with options requires human review");
  if (program === "set" && !args.every((word) => /^[-+][B-Za-z]+$|^pipefail$/.test(word)))
    return human(request, "unknown", "Changing shell settings requires human review");
  if (SHELLS.has(program) || INTERPRETERS.has(program)) {
    if (stageIndex > 0)
      return human(request, "unknown", "Piping into a shell or interpreter requires human review");
    if (SHELLS.has(program)) {
      const inline = args.indexOf("-c");
      // A shell fed by a heredoc runs exactly that text, so judge it as a script.
      const script =
        inline >= 0
          ? args[inline + 1]
          : (args.length === 0 || args.every((arg) => arg === "-" || arg === "-s")) &&
              command.stdin !== undefined
            ? command.stdin
            : undefined;
      if (script === undefined || depth >= 2)
        return human(request, "unknown", "Shell invocation requires human review");
      return commandDecision(request, script, profile, depth + 1, [cwd]);
    }
    // Inline code and a heredoc body are both literal text, so both can be read. Code piped in
    // from elsewhere cannot.
    const fromStdin = args.length === 0 || args[0] === "-";
    const inlineAt = args.findIndex((arg) => ["-c", "-e", "-p", "--eval", "--print"].includes(arg));
    const code = fromStdin ? command.stdin : inlineAt >= 0 ? args[inlineAt + 1] : undefined;
    if (fromStdin && code === undefined)
      return human(
        request,
        "unknown",
        "Interpreter reading code from standard input requires human review",
      );
    const unsafe = code === undefined ? undefined : interpreterCodeRefusal(code);
    if (unsafe) return human(request, "unknown", unsafe);
  }
  if (
    program === "xargs" &&
    args.some(
      (arg) =>
        // zsh expands `=rm` to the path of rm.
        DESTRUCTIVE.has(basename(arg.replace(/^=/, ""))) ||
        SHELLS.has(basename(arg.replace(/^=/, ""))) ||
        basename(arg.replace(/^=/, "")) === "git",
    )
  )
    return human(
      request,
      "destructive",
      "xargs into a destructive or shell command requires human review",
    );
  if (
    program === "find" &&
    args.some((arg) =>
      ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(
        arg,
      ),
    )
  )
    return human(request, "destructive", "find with actions requires human review");
  if (["chmod", "chown"].includes(program) && args.some((arg) => /^-[a-zA-Z]*R/.test(arg)))
    return human(request, "destructive", "Recursive permission changes require human approval");
  if (
    (program === "sed" &&
      args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) ||
    (program === "perl" && args.some((arg) => /^-[a-zA-Z]*i/.test(arg)))
  ) {
    const files =
      program === "sed"
        ? textOperands(program, args).files
        : args.filter((arg) => !arg.startsWith("-")).slice(1);
    for (const file of files) {
      const check = permissiveWrite(cwd, file, profile);
      if (!check.allowed) return human(request, check.category, check.reason);
    }
  } else if (WRITERS.has(program)) {
    // Option values can name a target too: `--target-directory=/etc`, `-t/etc`.
    const optionValues = args.flatMap((arg) => {
      const value =
        /^--[^=]+=(.+)$/.exec(arg)?.[1] ??
        (["cp", "mv", "ln", "install"].includes(program)
          ? /^-[a-zA-Z]*t(.+)$/.exec(arg)?.[1]
          : undefined);
      return value === undefined ? [] : [value];
    });
    for (const file of [
      ...args.filter((arg) => !arg.startsWith("-") && !/^[0-9]+$/.test(arg)),
      ...optionValues,
    ]) {
      const check = permissiveWrite(cwd, file, profile);
      if (!check.allowed) return human(request, check.category, check.reason);
    }
  }
  if (program === "terraform" || program === "pulumi" || program === "tofu")
    if (
      args.includes("destroy") ||
      args.includes("-destroy") ||
      (args[0] === "state" && ["rm", "push"].includes(args[1] ?? ""))
    )
      return human(request, "destructive", "Infrastructure destruction requires human approval");
  if (program === "kubectl" && ["delete", "drain", "replace", "cordon"].includes(args[0] ?? ""))
    return human(request, "destructive", "Cluster deletion requires human approval");
  if (
    program === "docker" &&
    (["rm", "rmi", "kill", "prune"].includes(args[0] ?? "") ||
      args.includes("prune") ||
      (args[0] === "volume" && args[1] === "rm"))
  )
    return human(request, "destructive", "Container deletion requires human approval");
  if (
    ["npm", "pnpm", "yarn"].includes(program) &&
    ["publish", "unpublish", "deprecate", "owner", "token"].includes(args[0] ?? "")
  )
    return human(request, "destructive", "Publishing or registry changes require human approval");
  if (program === "dotnet" && args[0] === "nuget" && ["push", "delete"].includes(args[1] ?? ""))
    return human(request, "destructive", "Package publishing requires human approval");
  if (
    (program === "curl" || program === "wget") &&
    /(?:-X|--request)[=\s]?(?:DELETE|PUT)\b/i.test(joined)
  )
    return human(request, "destructive", "Destructive HTTP verbs require human approval");
  if (program === "git") return gitDecision(request, argv, cwd);
  if (program === "gh") {
    const gh = ghDecision(request, argv);
    if (gh) return gh;
  }
  if (["az", "aws", "gcloud"].includes(program)) return cloudDecision(request, argv, profile);
  return result(
    request,
    "impactful-write",
    "Permissive profile: no destructive effect detected",
    true,
  );
}

export { commandDecision };
