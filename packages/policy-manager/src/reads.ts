import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  canonical,
  git,
  inside,
  policyState,
  protectedPath,
  resolveWord,
  sensitive,
} from "./evidence.js";
import { wildcard } from "./nativerules.js";
import { defaultProfilePath } from "./profile.js";
import { parseShell } from "./shell.js";
import type { Request } from "./types.js";

/**
 * Plain reads are approved under protected paths (`.claude`, `.codex`, `.agent-config`, `.github`,
 * `AGENTS.md`, `CLAUDE.md`, ...) as anywhere else in a checkout: reading configuration changes
 * nothing. Writes, and reads of credential and secret files, still go to a person.
 *
 * A plain read is tight on purpose: one of a few reading programs (or the Read tool), joined only by
 * `&&`, `||`, `;` and pipes into another reading program, with an optional `cd <dir>`; no command
 * substitution, variables, assignments, here-documents or redirections other than `2>/dev/null`,
 * `2>&1` and `<` from a file. Options are allow-listed per program: any option not listed below is
 * not a plain read. Every named path must be inside a Git checkout or under a protected directory,
 * none may be a secret, and a recursive search may not reach one.
 */
interface Options {
  /** Short flags that may be combined (`-rn`). */
  flags: RegExp;
  /** Options that take the next word (or an attached value) as their value. */
  valued: Set<string>;
  /** Of `valued`, those whose value is a file to read. */
  files?: Set<string>;
  /** Long options, with or without `=value`. */
  long: Set<string>;
  /** Long options whose value is a file to read. */
  longFiles?: Set<string>;
}
const GREP: Options = {
  flags: /^-[nrRiwvclLHhoEFsqxIZz]+$/,
  valued: new Set(["-e", "-f", "-A", "-B", "-C", "-m"]),
  files: new Set(["-f"]),
  long: new Set([
    ...["--include", "--exclude", "--exclude-dir", "--color", "--colour", "--line-number"],
    ...["--recursive", "--ignore-case", "--files-with-matches", "--files-without-match"],
    ...["--count", "--fixed-strings", "--extended-regexp", "--word-regexp", "--invert-match"],
    ...["--max-count", "--context", "--before-context", "--after-context", "--no-messages"],
    ...["--with-filename", "--no-filename", "--only-matching", "--quiet", "--null"],
    ...["--binary-files", "--regexp", "--line-regexp"],
  ]),
  longFiles: new Set(["--file"]),
};
const OPTIONS: Record<string, Options> = {
  cat: { flags: /^-[nbsvetAETu]+$/, valued: new Set(), long: new Set(["--number"]) },
  ls: {
    flags: /^-[aAlhRtrSs1dFGipcunog]+$/,
    valued: new Set(),
    long: new Set(["--color", "--all", "--almost-all", "--human-readable", "--recursive"]),
  },
  head: {
    flags: /^-(?:\d+|[qv]+)$/,
    valued: new Set(["-n", "-c"]),
    long: new Set(["--lines", "--bytes", "--quiet", "--verbose"]),
  },
  tail: {
    flags: /^-(?:\d+|[qv]+)$/,
    valued: new Set(["-n", "-c"]),
    long: new Set(["--lines", "--bytes", "--quiet", "--verbose"]),
  },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  // ripgrep skips hidden files and honors ignore files; options that change that are not listed.
  rg: {
    flags: /^-[niSswlcFHNoqvxI0]+$/,
    valued: new Set(["-e", "-g", "-t", "-T", "-A", "-B", "-C", "-m", "-M", "-f"]),
    files: new Set(["-f"]),
    long: new Set([
      ...["--glob", "--iglob", "--type", "--type-not", "--max-count", "--context"],
      ...["--before-context", "--after-context", "--no-heading", "--heading", "--line-number"],
      ...["--ignore-case", "--smart-case", "--case-sensitive", "--fixed-strings", "--files"],
      ...["--files-with-matches", "--count", "--json", "--color", "--word-regexp", "--trim"],
      ...["--max-columns", "--sort", "--vimgrep", "--no-messages", "--only-matching"],
      ...["--regexp", "--invert-match", "--with-filename", "--no-filename", "--null"],
    ]),
    longFiles: new Set(["--file"]),
  },
  // `git grep` reads tracked content only; `--untracked` and `--no-index` are not listed.
  "git-grep": {
    flags: /^-[niwlLcvEFPIhHz]+$/,
    valued: new Set(["-e", "-f", "-A", "-B", "-C", "-m"]),
    files: new Set(["-f"]),
    long: new Set([
      ...["--line-number", "--ignore-case", "--word-regexp", "--files-with-matches"],
      ...["--count", "--heading", "--break", "--cached", "--name-only", "--invert-match"],
      ...["--extended-regexp", "--fixed-strings", "--perl-regexp", "--max-depth", "--color"],
      ...["--no-color", "--full-name", "--max-count", "--context", "--and", "--or", "--not"],
    ]),
  },
};
/** `find` predicates that only select and print names, with whether each takes a value. */
const FIND: Record<string, boolean> = {
  ...Object.fromEntries(
    ["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-newer"]
      .concat(["-mtime", "-mmin", "-size", "-regex", "-iregex", "-perm", "-user", "-group"])
      .map((name) => [name, true]),
  ),
  ...Object.fromEntries(
    ["-print", "-print0", "-o", "-or", "-a", "-and", "-not", "!", "(", ")", "-prune", "-empty"]
      .concat(["-true", "-false", "-depth", "-xdev"])
      .map((name) => [name, false]),
  ),
};

/**
 * File names that hold or may hold credentials: harness settings (they can carry tokens in `env`),
 * login stores, the policy profile, and the credential names `sensitive` already knows.
 */
const SECRET_NAME =
  /^(?:\.?credentials?(?:\..*)?|auth\.json|\.claude\.json|settings(?:\.local)?\.json|config\.toml|config\.json|hooks\.json|permissions-config\.json|policy\.json|\.netrc|.*\.(?:sqlite3?|db|keychain(?:-db)?))$/i;

/** Whether a path, as written or resolved, is a credential or secret-bearing file. */
export function secretPath(path: string): boolean {
  const slashed = path.replace(/\\/g, "/");
  return (
    sensitive(slashed) ||
    policyState(slashed) ||
    slashed === defaultProfilePath().replace(/\\/g, "/") ||
    slashed.split("/").some((part) => SECRET_NAME.test(part))
  );
}

function inCheckout(path: string): boolean {
  try {
    let dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
    while (!existsSync(dir)) dir = dirname(dir);
    const top = canonical(git(dir, ["rev-parse", "--show-toplevel"]));
    return inside(top, canonical(path));
  } catch {
    return false;
  }
}

function resolveSafe(cwd: string, word: string): string | undefined {
  try {
    return resolveWord(cwd, word);
  } catch {
    return undefined;
  }
}

/** A path word a plain read may name: inside a checkout or a protected directory, and no secret. */
function readable(cwd: string, word: string): boolean {
  if (secretPath(word)) return false;
  const lexical = resolveSafe(cwd, word);
  if (lexical === undefined) return false;
  let real = lexical;
  try {
    real = canonical(lexical);
  } catch {
    /* judged as written */
  }
  if (secretPath(lexical) || secretPath(real)) return false;
  return inCheckout(real) || protectedPath(real) || protectedPath(lexical);
}

const WALK_LIMIT = 5000;
/**
 * Whether a recursive search of `dir` can reach a secret file. ripgrep (`hidden: false`) skips
 * hidden entries; grep reads everything except what `--exclude`/`--exclude-dir` name. Fails closed
 * past WALK_LIMIT entries or on an unreadable directory.
 */
function reachesSecret(
  dir: string,
  hidden: boolean,
  exclude: string[],
  excludeDir: string[],
): boolean {
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return true;
    }
    for (const name of names) {
      if (++seen > WALK_LIMIT) return true;
      if (!hidden && name.startsWith(".")) continue;
      const path = join(current, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch {
        return true;
      }
      if (stat.isSymbolicLink()) continue; // neither grep -r nor rg follows links by default
      if (stat.isDirectory()) {
        if (excludeDir.some((glob) => wildcard(glob, name))) continue;
        if (secretPath(path)) return true;
        stack.push(path);
      } else if (!exclude.some((glob) => wildcard(glob, name)) && secretPath(path)) return true;
    }
  }
  return false;
}

interface Parsed {
  /** Words that name files to read (operands and file-valued options). */
  paths: string[];
  /** Recursive search (grep -r, any rg). */
  recursive: boolean;
  exclude: string[];
  excludeDir: string[];
}

/** The options and operands of a reading command, or undefined if any option is not listed. */
function parse(program: string, args: string[]): Parsed | undefined {
  const parsed: Parsed = {
    paths: [],
    recursive: program === "rg",
    exclude: [],
    excludeDir: [],
  };
  if (program === "find") {
    let predicates = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg in FIND) {
        predicates = true;
        if (FIND[arg]) i++;
      } else if (arg.startsWith("-") || predicates) return undefined;
      else parsed.paths.push(arg);
    }
    return parsed;
  }
  const options = OPTIONS[program];
  if (!options) return undefined;
  // grep and rg take the pattern as the first operand unless -e/-f gave one.
  const given = args.some(
    (arg) =>
      arg === "--files" ||
      /^-[ef]/.test(arg) ||
      /^--(?:regexp|file)(?:=|$)/.test(arg) ||
      /^-[^-]*[ef]$/.test(arg),
  );
  let pattern = ["grep", "egrep", "fgrep", "rg", "git-grep"].includes(program) && !given;
  let operandsOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (operandsOnly || arg === "-" || !arg.startsWith("-")) {
      // A pattern is not read, but one that names a secret path is not taken on trust either.
      if (pattern) {
        if (secretPath(arg)) return undefined;
        pattern = false;
      } else parsed.paths.push(arg);
      continue;
    }
    if (arg === "--") {
      operandsOnly = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [name = "", ...rest] = arg.split("=");
      const value = rest.join("=");
      if (options.longFiles?.has(name)) {
        parsed.paths.push(value || (args[++i] ?? ""));
        pattern = false;
        continue;
      }
      if (!options.long.has(name)) return undefined;
      if (name === "--recursive") parsed.recursive = true;
      if (name === "--regexp") pattern = false;
      if (name === "--exclude" && value) parsed.exclude.push(value);
      if (name === "--exclude-dir" && value) parsed.excludeDir.push(value);
      continue;
    }
    const short = arg.slice(0, 2);
    if (options.valued.has(short)) {
      const value = arg.length > 2 ? arg.slice(2) : args[++i];
      if (value === undefined) return undefined;
      if (short === "-e" || short === "-f") pattern = false;
      if (options.files?.has(short)) parsed.paths.push(value);
      continue;
    }
    if (!options.flags.test(arg)) return undefined;
    if (program !== "ls" && /[rR]/.test(arg.slice(1)) && program !== "git-grep")
      parsed.recursive = true;
  }
  return parsed;
}

/** Whether a request is a plain read of non-secret paths in a checkout or protected directory. */
export function plainRead(request: Request): boolean {
  const input = request.input;
  if (input.env !== undefined || input.shell !== undefined || input.stdin !== undefined)
    return false;
  if (["Read", "view", "read_file"].includes(request.tool)) {
    const file = input.file_path ?? input.path;
    return typeof file === "string" && readable(request.cwd, file);
  }
  const command = input.command ?? input.cmd;
  if (!["Bash", "bash", "exec_command", "shell"].includes(request.tool)) return false;
  if (typeof command !== "string" || command.length > 4000) return false;
  const pipelines = parseShell(command);
  if (!pipelines) return false;
  let checked = 0;
  // A `cd <dir>` may lead or join the reads; a later word is judged in every directory it could
  // run in, since `cd x || cat y` reads from the old one.
  const cwds = new Set([request.cwd]);
  for (const pipeline of pipelines)
    for (const cmd of pipeline) {
      if (cmd.env.length || cmd.subs.length || cmd.stdin !== undefined) return false;
      const program = cmd.argv[0] ?? "";
      const gitGrep = program === "git" && cmd.argv[1] === "grep";
      // `git grep` pathspecs (`'**/*.md'`, `':(glob)src/**'`) are Git's, not files to expand.
      if (cmd.loose?.some(Boolean) || (!gitGrep && cmd.glob?.some(Boolean))) return false;
      if (program === "cd" && pipeline.length === 1) {
        const target = cmd.argv[1];
        if (cmd.argv.length !== 2 || !target || target.startsWith("-") || cmd.redirects.length)
          return false;
        for (const dir of [...cwds]) {
          const next = resolveSafe(dir, target);
          if (next === undefined || !existsSync(next)) return false;
          cwds.add(next);
        }
        if (cwds.size > 4) return false;
        continue;
      }
      const parsed = parse(gitGrep ? "git-grep" : program, cmd.argv.slice(gitGrep ? 2 : 1));
      if (!parsed) return false;
      for (const redirect of cmd.redirects) {
        if (redirect.op === ">&" && redirect.target === "1" && redirect.fd === "2") continue;
        if (redirect.op === ">" && redirect.fd === "2" && redirect.target === "/dev/null") continue;
        if (redirect.op === "<") {
          parsed.paths.push(redirect.target);
          continue;
        }
        return false;
      }
      for (const cwd of cwds) {
        // A reader with no path searches or lists the directory it runs in.
        if (!readable(cwd, ".")) return false;
        if (gitGrep) {
          // Git reads tracked files only: none of them may be a secret.
          if (parsed.paths.some((word) => secretPath(word))) return false;
          try {
            const tracked = git(cwd, ["ls-files", "-z"]).split("\0");
            if (tracked.some((file) => file && secretPath(file))) return false;
          } catch {
            return false;
          }
          continue;
        }
        const targets = parsed.paths.length ? parsed.paths : ["."];
        for (const word of parsed.paths) if (++checked > 32 || !readable(cwd, word)) return false;
        if (parsed.recursive)
          for (const word of targets) {
            const path = resolveSafe(cwd, word);
            if (path === undefined) return false;
            let directory = false;
            try {
              directory = statSync(path).isDirectory();
            } catch {
              return false;
            }
            if (
              directory &&
              reachesSecret(path, program !== "rg", parsed.exclude, parsed.excludeDir)
            )
              return false;
            if (!directory && secretPath(basename(path))) return false;
          }
      }
    }
  return true;
}
