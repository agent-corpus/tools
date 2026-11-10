import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  branchEvidence,
  canonical,
  inside,
  isProtectedPath,
  pathEvidence,
  sensitive,
} from "./evidence.js";
import { mergedEvidence, remoteTipMatches } from "./merged.js";
import { evaluateArgv, result } from "./policy.js";
import type { Profile } from "./profile.js";
import { parseShell, type SimpleCommand } from "./shell.js";
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
const BANNED_ENV =
  /^(?:LD_|DYLD_|GIT_|PYTHON|NODE_OPTIONS$|PATH$|HOME$|BASH_ENV$|ENV$|SHELL$|PAGER$|EDITOR$|GH_TOKEN$|GITHUB_TOKEN$)/;
const FORCE_PUSH = ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--prune"];

function human(request: Request, category: Decision["category"], reason: string): Decision {
  return result(request, category, reason);
}

export function permissiveRead(cwd: string, input: string) {
  try {
    const lexical = resolve(cwd, input);
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
  try {
    const lexical = resolve(cwd, input);
    const path = canonical(lexical);
    if (sensitive(path) || sensitive(lexical) || isProtectedPath(path) || isProtectedPath(lexical))
      return {
        allowed: false,
        category: "sensitive" as const,
        reason: "Protected path requires human approval",
      };
    // Never let a scratch root reach the policy service's own session directories.
    if (
      !path.split(/[\\/]/).some((part) => part.startsWith("acp-")) &&
      profile.scratchRoots.some((root) => inside(root, path))
    )
      return {
        allowed: true,
        category: "worktree-write" as const,
        reason: "Write within a scratch directory",
      };
  } catch {
    /* fall through to the repository check, which fails closed */
  }
  return pathEvidence(cwd, input, true);
}

interface Unwrapped {
  argv: string[];
  /** Assignments given to `env`, which the parser does not see as shell assignments. */
  env: string[];
  refusal?: string;
}

function unwrap(argv: string[]): Unwrapped {
  let current = argv;
  const env: string[] = [];
  for (let depth = 0; depth < 4; depth++) {
    const program = basename(current[0] ?? "");
    if (!WRAPPERS.has(program) || program === "xargs") return { argv: current, env };
    let rest = current.slice(1);
    while (
      rest[0]?.startsWith("-") ||
      (program === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0] ?? "")) ||
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

function simpleDecision(
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
    // `>& word` duplicates a descriptor only when word is a number or `-`; otherwise it names a file.
    if (
      redirect.target === "/dev/null" ||
      (redirect.op === ">&" && /^(?:[0-9]+|-)$/.test(redirect.target))
    )
      continue;
    const check =
      redirect.op === "<"
        ? permissiveRead(cwd, redirect.target)
        : permissiveWrite(cwd, redirect.target, profile);
    if (!check.allowed) return human(request, check.category, check.reason);
  }
  const unwrapped = unwrap(command.argv);
  if (unwrapped.refusal) return human(request, "unknown", unwrapped.refusal);
  for (const name of unwrapped.env)
    if (BANNED_ENV.test(name))
      return human(request, "unknown", "Environment override requires human review");
  const argv = unwrapped.argv;
  const program = basename(argv[0] ?? "");
  const args = argv.slice(1);
  const joined = argv.join(" ");
  if (profile.humanPatterns.some((pattern) => pattern.test(joined)))
    return human(request, "destructive", "Matches an organization human-approval pattern");
  // Anything that looks like a credential or protected-config path stays with a human.
  for (const word of argv.slice(1)) {
    const candidate = word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
    if (candidate.includes("/") || candidate.startsWith(".")) {
      if (sensitive(candidate))
        return human(request, "sensitive", "Protected path requires human approval");
    }
  }
  if (DESTRUCTIVE.has(program) || program.startsWith("mkfs"))
    return human(request, "destructive", "Destructive operation requires human approval");
  if (SHELLS.has(program) || INTERPRETERS.has(program)) {
    if (stageIndex > 0)
      return human(request, "unknown", "Piping into a shell or interpreter requires human review");
    if (SHELLS.has(program)) {
      const inline = args.indexOf("-c");
      const script = inline >= 0 ? args[inline + 1] : undefined;
      if (script === undefined || depth >= 2)
        return human(request, "unknown", "Shell invocation requires human review");
      return commandDecision(request, script, profile, depth + 1, [cwd]);
    }
    if (args.length === 0 || args[0] === "-")
      return human(
        request,
        "unknown",
        "Interpreter reading code from standard input requires human review",
      );
  }
  if (
    program === "xargs" &&
    args.some(
      (arg) =>
        DESTRUCTIVE.has(basename(arg)) || SHELLS.has(basename(arg)) || basename(arg) === "git",
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
    for (const file of args.filter((arg) => !arg.startsWith("-")).slice(1)) {
      const check = permissiveWrite(cwd, file, profile);
      if (!check.allowed) return human(request, check.category, check.reason);
    }
  } else if (WRITERS.has(program)) {
    for (const file of args.filter((arg) => !arg.startsWith("-") && !/^[0-9]+$/.test(arg))) {
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

const MAX_DIRECTORIES = 8;

/**
 * Evaluates a compound command. `cd <literal>` is tracked: every later command is judged in each
 * directory it could run in (before and after the `cd`, since `cd x || ...` may fail), so a command
 * that only looks safe relative to the starting directory cannot hide behind a `cd`.
 */
export function commandDecision(
  request: Request,
  command: string,
  profile: Profile,
  depth = 0,
  start: string[] = [request.cwd],
): Decision {
  const pipelines = parseShell(command);
  if (!pipelines)
    return human(
      request,
      "unknown",
      "Unsupported shell syntax; expansions and subshells need human review",
    );
  let cwds = [...start];
  let last: Decision | undefined;
  for (const pipeline of pipelines)
    for (const [index, simple] of pipeline.entries()) {
      if (basename(simple.argv[0] ?? "") === "cd") {
        const target = simple.argv.slice(1).filter((word) => word !== "--");
        // A bare `cd` and `~` or `~/x` go to the home directory; `~user` and `-` stay with a human.
        const raw = target.length === 0 ? "~" : target[0];
        const word = raw === "~" || raw?.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
        if (target.length > 1 || !word || /^~|[*?[\]]/.test(word) || word.startsWith("-"))
          return human(request, "unknown", "Directory change requires human review");
        // The cd's own redirections, env assignments and organization patterns run first, in the
        // directories it could start from.
        for (const cwd of cwds) {
          const own = simpleDecision(request, simple, profile, depth, index, cwd);
          if (own.decision !== "approve") return own;
        }
        cwds = [...new Set([...cwds, ...cwds.map((cwd) => resolve(cwd, word))])];
        if (cwds.length > MAX_DIRECTORIES)
          return human(request, "unknown", "Too many directory changes to verify");
        last = result(request, "code-read", "Directory change", true);
        continue;
      }
      for (const cwd of cwds) {
        last = simpleDecision(request, simple, profile, depth, index, cwd);
        if (last.decision !== "approve") return last;
      }
    }
  return last ?? human(request, "unknown", "Empty command");
}
