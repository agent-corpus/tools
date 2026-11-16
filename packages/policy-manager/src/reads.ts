import { accessSync, constants, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  canonical,
  git,
  inside,
  policyState,
  resolveWord,
  sensitive,
  tempRoots,
} from "./evidence.js";
import { wildcard } from "./nativerules.js";
import { defaultProfilePath } from "./profile.js";
import { parseShell } from "./shell.js";
import type { Request } from "./types.js";

/**
 * Plain reads are approved under a checkout's protected paths (`.claude`, `.codex`,
 * `.agent-config`, `.github`, `AGENTS.md`, `CLAUDE.md`, ...) as anywhere else in it: reading
 * configuration changes nothing. Writes, and reads of credential and secret files, still go to a
 * person.
 *
 * A plain read is tight on purpose: one of a few reading programs (or the Read tool), joined only by
 * `&&`, `||`, `;` and pipes into another reading program, with an optional `cd <dir>`; no command
 * substitution, variables, assignments, here-documents or redirections other than `2>/dev/null`,
 * `2>&1` and `<` from a file. Options are allow-listed per program: any option not listed below is
 * not a plain read. Every named path must pass `readable` (a checkout, temp, a scratch root or
 * Claude Code's auto-memory), none may be a secret, and a recursive search may not reach one.
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
const TRACKED_SECRET =
  /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$|dist$)[^/]*)?|\.git-credentials|\.netrc|\.pgpass|\.vault-token|credentials?(?:\.\w+)?|secrets?(?:\.\w+)?|id_(?:rsa|ed25519|ecdsa)|kubeconfig|terraform\.tfstate(?:\.\w+)?|[^/]*\.(?:pem|key|pfx|p12))$/i;
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

/**
 * Claude Code's auto-memory directories (`<config>/projects/<project>/memory/`), the only part of
 * the user's agent state a plain read may name. Transcripts and history next to them may not.
 */
function autoMemory(path: string): boolean {
  try {
    const config = canonical(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    if (!inside(config, path)) return false;
    const parts = relative(config, path).split(/[\\/]/);
    return parts.length >= 3 && parts[0] === "projects" && parts[2] === "memory";
  } catch {
    return false;
  }
}

/**
 * The one test of whether a read may name a path, shared by plain reads and read-only chain
 * prefixes: no secret, and inside a Git checkout (its own `.claude`, `.agent-config`, `AGENTS.md`
 * included), the system temp directory, a profile scratch root, or Claude Code's auto-memory.
 * Elsewhere under the home directory (agent transcripts and history, `.config`, `.local`, shell
 * history) it may not.
 */
export function readable(cwd: string, word: string, roots: readonly string[] = []): boolean {
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
  const under = (root: string) => {
    try {
      const base = canonical(root);
      return real !== base ? inside(base, real) : true;
    } catch {
      return false;
    }
  };
  return inCheckout(real) || tempRoots().some(under) || roots.some(under) || autoMemory(real);
}

/**
 * The directory a `cd` to `target` enters for certain, or undefined: an absolute path (or `~/...`)
 * to an existing directory that can be entered now. As a script's first command such a `cd` cannot
 * fail, so what follows runs only there, however it is joined.
 */
export function enterable(target: string): string | undefined {
  if (!/^(?:\/|~\/|~$|[A-Za-z]:[\\/])/.test(target)) return undefined;
  if (process.env.CDPATH && !/^[/~]/.test(target)) return undefined;
  try {
    const dir = resolveWord("/", target);
    if (!statSync(dir).isDirectory()) return undefined;
    accessSync(dir, constants.X_OK);
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * Whether a word given to a read-only program may be read if it names a file: a word that names an
 * existing path must be `readable`, one that cannot be resolved is refused, and none may name a
 * secret. The value of `--opt=value` is judged the same way.
 */
export function operandReadable(cwd: string, word: string, roots: readonly string[] = []): boolean {
  const value = word.startsWith("-") ? /^-[^=]*=(.+)$/.exec(word)?.[1] : word;
  if (value === undefined) return true;
  const revisionPath = /^[^:\s]*:(.+)$/.exec(value)?.[1];
  if (secretPath(value) || (revisionPath && secretPath(revisionPath))) return false;
  const path = resolveSafe(cwd, value);
  if (path === undefined) return false;
  return !existsSync(path) || readable(cwd, value, roots);
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
        // A name pattern is not read, but one that names a secret is not taken on trust.
        if (FIND[arg] && secretPath(args[++i] ?? "")) return undefined;
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
export function plainRead(request: Request, roots: readonly string[] = []): boolean {
  const input = request.input;
  if (input.env !== undefined || input.shell !== undefined || input.stdin !== undefined)
    return false;
  if (["Read", "view", "read_file"].includes(request.tool)) {
    const file = input.file_path ?? input.path;
    return typeof file === "string" && readable(request.cwd, file, roots);
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
        // As the script's first command, a `cd` that cannot fail leaves only its target.
        // After `||` the next command runs exactly when it fails, so `||` anywhere keeps the old one.
        const sure =
          pipeline === pipelines[0] && !command.includes("||") ? enterable(target) : undefined;
        if (sure) {
          cwds.clear();
          cwds.add(sure);
          continue;
        }
        for (const dir of [...cwds]) {
          const next = resolveSafe(dir, target);
          if (next === undefined || !existsSync(next)) return false;
          cwds.add(next);
        }
        if (cwds.size > 4) return false;
        continue;
      }
      if (!(program in OPTIONS) && program !== "find" && !gitGrep) {
        // A read-only filter or git read (`git show rev:path | sed -n 1,9p | sort | uniq -c`):
        // only allow-listed options; a word that names an existing file must be a readable,
        // non-secret path, and no word (a script, a pattern, `rev:path`) may name a secret.
        if (!readOnly(cmd.argv)) return false;
        for (const word of cmd.argv.slice(1))
          for (const cwd of cwds)
            if (++checked > 64 || !operandReadable(cwd, word, roots)) return false;
        for (const redirect of cmd.redirects) {
          if (redirect.op === ">&" && redirect.target === "1" && redirect.fd === "2") continue;
          if (redirect.op === ">" && redirect.fd === "2" && redirect.target === "/dev/null")
            continue;
          if (redirect.op === "<" && readable(request.cwd, redirect.target, roots)) continue;
          return false;
        }
        for (const cwd of cwds) if (!readable(cwd, ".", roots)) return false;
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
        if (!readable(cwd, ".", roots)) return false;
        if (gitGrep) {
          // Git reads tracked files only: none of them may be a secret.
          if (parsed.paths.some((word) => secretPath(word))) return false;
          try {
            const tracked = git(cwd, ["ls-files", "-z"]).split("\0");
            // Tracked files that would hold a credential (a committed `.npmrc` or `.env.example`
            // is configuration already in history; a committed `.env`, key or state file is not).
            if (tracked.some((file) => TRACKED_SECRET.test(file))) return false;
          } catch {
            return false;
          }
          continue;
        }
        const targets = parsed.paths.length ? parsed.paths : ["."];
        for (const word of parsed.paths)
          if (++checked > 32 || !readable(cwd, word, roots)) return false;
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
/**
 * Programs and git subcommands that change nothing a later command could see, each with the only
 * options it may take: an option that writes a file (`--output`, `-o`) or runs a program
 * (`--ext-diff`, `--compress-program`) is never listed, and an unlisted option is not read-only.
 * `flags` matches a whole option word; `valued` options take the next word as their value.
 */
interface ReadOnlySpec {
  flags?: RegExp;
  valued?: string[];
  /** Operands are allowed (files, revisions, patterns). */
  operands?: boolean;
  /** Extra check on the operands. */
  check?: (operands: string[]) => boolean;
}

const READ_ONLY: Record<string, ReadOnlySpec> = {
  pwd: { flags: /^-[LP]$/ },
  true: {},
  echo: { flags: /^-[neE]+$/, operands: true },
  printf: { operands: true },
  stat: { flags: /^-[LtFlsx]+$/, valued: ["-f", "-c"], operands: true },
  file: { flags: /^-[bLhiz]+$/, operands: true },
  which: { flags: /^-a$/, operands: true },
  basename: { flags: /^-[az]$/, valued: ["-s"], operands: true },
  dirname: { operands: true },
  realpath: { flags: /^-[esmqz]+$/, operands: true },
  date: { flags: /^(?:-[uRI]|-I\w+|\+.*)$/, operands: false },
  wc: { flags: /^-[lwcmL]+$/, operands: true },
  cut: { valued: ["-d", "-f", "-c", "-b"], flags: /^-(?:[dfcb].+|s|n)$/, operands: true },
  tr: { flags: /^-[dsc]+$/, operands: true },
  nl: { flags: /^-[bnv]\w*$/, operands: true },
  column: { flags: /^-[tx]+$/, valued: ["-s"], operands: true },
  jq: { flags: /^-[rcesnjaS]+$/, valued: ["--arg", "--argjson"], operands: true },
  diff: {
    flags: /^(?:-[uqNwBbiyU0-9]+|--brief|--unified(?:=\d+)?|--color(?:=\w+)?)$/,
    operands: true,
  },
  cmp: { flags: /^-[bls]+$/, operands: true },
  comm: { flags: /^-[123]+$/, operands: true },
  sort: { flags: /^-[nrufbdhVMs]+$/, valued: ["-k", "-t"], operands: true },
  // uniq writes its second operand: standard input only.
  uniq: { flags: /^-[cdui]+$/, valued: ["-f", "-s"], operands: false },
  find: {
    flags:
      /^(?:-(?:name|iname|path|ipath|type|maxdepth|mindepth|newer|mtime|mmin|size|regex|iregex|perm|user|group|print|print0|o|or|a|and|not|prune|empty|true|false|depth|xdev)|!|\(|\))$/,
    operands: true,
  },
};
const GIT_READ_ONLY: Record<string, ReadOnlySpec> = {
  status: {
    flags:
      /^(?:-[sbz]+|--short|--branch|--porcelain(?:=v[12])?|-u\w*|--untracked-files(?:=\w+)?|--ignored)$/,
    operands: true,
  },
  log: {
    flags:
      /^(?:-\d+|-[pz]|--oneline|--graph|--decorate(?:=\w+)?|--stat|--shortstat|--name-only|--name-status|--no-merges|--merges|--first-parent|--reverse|--all|--abbrev-commit|--no-color|--color(?:=\w+)?|--(?:format|pretty|since|until|after|before|author|grep|date|max-count|skip)=.*|--)$/,
    valued: ["-n"],
    operands: true,
  },
  diff: {
    flags:
      /^(?:--stat(?:=\d+)?|--shortstat|--numstat|--name-only|--name-status|--cached|--staged|-U\d+|--unified=\d+|--no-color|--color(?:=\w+)?|-w|--ignore-space-change|--ignore-all-space|--exit-code|--quiet|-M|-R|--)$/,
    operands: true,
  },
  show: {
    flags:
      /^(?:--stat|--name-only|--name-status|--oneline|-s|--no-patch|--no-color|--color(?:=\w+)?|-U\d+|--(?:format|pretty)=.*|--)$/,
    operands: true,
  },
  "rev-parse": {
    flags:
      /^(?:--abbrev-ref|--short(?:=\d+)?|--verify|--quiet|-q|--show-toplevel|--git-dir|--git-common-dir|--absolute-git-dir|--path-format=\w+|--symbolic-full-name|--is-inside-work-tree)$/,
    operands: true,
  },
  "ls-files": {
    flags: /^(?:-[zcmdoti]+|--others|--cached|--modified|--deleted|--exclude-standard|--)$/,
    operands: true,
  },
  "for-each-ref": {
    flags: /^(?:--(?:format|count|sort|contains|merged|no-merged|points-at)(?:=.*)?)$/,
    operands: true,
  },
  "merge-base": { flags: /^(?:--is-ancestor|--all|--fork-point)$/, operands: true },
  "cat-file": { flags: /^-[tspe]$/, operands: true },
  describe: { flags: /^(?:--tags|--always|--long|--abbrev=\d+|--exact-match)$/, operands: true },
  "rev-list": {
    flags:
      /^(?:--count|--all|--max-count=\d+|--left-right|--not|--first-parent|--no-merges|-n\d*)$/,
    operands: true,
  },
  shortlog: { flags: /^-[sne]+$|^--(?:summary|numbered|email)$/, operands: true },
  blame: {
    flags: /^(?:-[wsef]+|-L.+|--porcelain|--line-porcelain)$/,
    valued: ["-L"],
    operands: true,
  },
  // A refspec with a destination (`+pull/1/head:refs/heads/x`) can overwrite a local branch.
  fetch: {
    flags: /^(?:-q|--quiet|--tags|--no-tags)$/,
    operands: true,
    // Only from `origin`: a fetch from another repository changes the refs the engine trusts.
    check: (operands) =>
      (operands[0] === undefined || operands[0] === "origin") &&
      operands.every((operand) => !operand.includes(":")),
  },
};
function allowed(spec: ReadOnlySpec, args: string[]): boolean {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith("-") && arg !== "-") {
      if (spec.valued?.includes(arg)) {
        if (args[++i] === undefined) return false;
        continue;
      }
      if (!spec.flags?.test(arg)) return false;
      continue;
    }
    if (arg === "!" || arg === "(" || arg === ")") {
      if (!spec.flags?.test(arg)) return false;
      continue;
    }
    // `find -name x`: the value of a find predicate.
    operands.push(arg);
  }
  if (operands.length && !spec.operands) return false;
  return spec.check ? spec.check(operands) : true;
}
export function readOnly(argv: string[]): boolean {
  const [program = "", ...args] = argv;
  if (program === "git") {
    let index = 0;
    while (args[index] === "-C" || args[index] === "--no-pager")
      index += args[index] === "-C" ? 2 : 1;
    if (args[index] === "grep") return true; // the full plain-read check follows
    const spec = GIT_READ_ONLY[args[index] ?? ""];
    return !!spec && allowed(spec, args.slice(index + 1));
  }
  // The readers (cat, ls, grep, rg, head, tail, git grep) get the full plain-read check instead.
  if (["cat", "ls", "grep", "egrep", "fgrep", "rg", "head", "tail"].includes(program)) return true;
  if (program === "sed") return sedReadOnly(args);
  if (["awk", "gawk", "mawk", "nawk"].includes(program)) return awkReadOnly(args);
  const spec = READ_ONLY[program];
  return !!spec && allowed(spec, args);
}

/**
 * sed that only prints: no `-i`, no script file, and every script free of the commands that write
 * a file or run one (`w`, `W`, `r`, `R`, `e`, an `s///` with the `w` or `e` flag). An unknown
 * command is not read-only.
 */
function sedReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  let given = false;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-e" || arg === "--expression") {
      const value = args[++i];
      if (value === undefined) return false;
      scripts.push(value);
      given = true;
    } else if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice(13));
      given = true;
    } else if (/^-e./.test(arg)) {
      scripts.push(arg.slice(2));
      given = true;
    } else if (
      /^-[nErsuz]+$/.test(arg) ||
      /^--(?:quiet|silent|regexp-extended|separate|null-data)$/.test(arg)
    )
      continue;
    else if (arg.startsWith("-")) return false;
    else operands.push(arg);
  }
  if (!given) {
    const script = operands.shift();
    if (script === undefined) return false;
    scripts.push(script);
  }
  return scripts.every(sedScriptReadOnly);
}

/**
 * awk that only reads and prints to standard output: no script file, and a program without
 * `system`, `getline`, a pipe or a `>` (a redirection, or a comparison it cannot tell apart).
 */
function awkReadOnly(args: string[]): boolean {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-F" || arg === "-v") {
      if (args[++i] === undefined) return false;
    } else if (/^-[Fv]./.test(arg)) continue;
    else if (arg.startsWith("-")) return false;
    else operands.push(arg);
  }
  const program = operands[0];
  return program !== undefined && !/system|getline|\||>|close\s*\(|fflush|print\s*>/.test(program);
}

/** Whether a sed script only prints: no file it reads or writes and no command it runs. */
function sedScriptReadOnly(script: string): boolean {
  const scanned = sedScript(script);
  return !!scanned && !scanned.runs && !scanned.files.length;
}

/**
 * The files a sed script reads or writes (`r`, `R`, `w`, `W`, an `s///w` flag) and whether it runs
 * a command (`e`, an `s///e` flag), read the way sed parses it: text in `s` and `y` patterns and
 * replacements, and after `a`, `i` and `c`, is data. Undefined when the script cannot be read.
 */
export function sedScript(script: string): { files: string[]; runs: boolean } | undefined {
  const files: string[] = [];
  let runs = false;
  let i = 0;
  const n = script.length;
  /** Reads up to an unescaped `delimiter`, past it. */
  const until = (delimiter: string): boolean => {
    while (i < n) {
      const c = script[i++];
      if (c === "\\") i++;
      else if (c === delimiter) return true;
    }
    return false;
  };
  /** The rest of the line: a file name. */
  const restOfLine = (): string => {
    const start = i;
    while (i < n && script[i] !== "\n") i++;
    return script.slice(start, i).trim();
  };
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i] as string)) i++;
    if (i >= n) break;
    // Addresses: line numbers, `$`, `/re/`, `\cREc`, ranges, steps and negation.
    for (;;) {
      const c = script[i];
      if (c !== undefined && /[\d$,!~+]/.test(c)) i++;
      else if (c === "/") {
        i++;
        if (!until("/")) return undefined;
      } else if (c === "\\" && script[i + 1] !== undefined) {
        const delimiter = script[i + 1] as string;
        i += 2;
        if (!until(delimiter)) return undefined;
      } else break;
    }
    while (i < n && /[ \t]/.test(script[i] as string)) i++;
    const command = script[i++];
    if (command === undefined) break;
    if (command === "{" || command === "}") continue;
    if (command === "s" || command === "y") {
      const delimiter = script[i++];
      if (delimiter === undefined || delimiter === "\\" || delimiter === "\n") return undefined;
      if (!until(delimiter) || !until(delimiter)) return undefined;
      if (command === "s") {
        while (i < n && /[gpIiMm0-9eE]/.test(script[i] as string)) {
          if (/[eE]/.test(script[i] as string)) runs = true;
          i++;
        }
        if (script[i] === "w" || script[i] === "W") {
          i++;
          files.push(restOfLine());
        }
      }
      continue;
    }
    if ("aic".includes(command)) {
      // Text to print: to the end of the line, and on past every line that ends in a backslash.
      while (i < n && !(script[i] === "\n" && script[i - 1] !== "\\")) i++;
      continue;
    }
    if ("rRwW".includes(command)) {
      files.push(restOfLine());
      continue;
    }
    if (command === "e") {
      runs = true;
      restOfLine();
      continue;
    }
    if (":btT".includes(command)) {
      while (i < n && !/[;\n]/.test(script[i] as string)) i++;
      continue;
    }
    if ("pPdDnNgGhHxlq=QzF".includes(command)) {
      while (i < n && /\d/.test(script[i] as string)) i++;
      continue;
    }
    return undefined;
  }
  return { files, runs };
}
