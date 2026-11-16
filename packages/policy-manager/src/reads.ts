import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonical,
  git,
  inside,
  policyState,
  protectedPath,
  resolveWord,
  sensitive,
} from "./evidence.js";
import { defaultProfilePath } from "./profile.js";
import { parseShell } from "./shell.js";
import type { Request } from "./types.js";

/**
 * Plain reads are approved under protected paths (`.claude`, `.codex`, `.agent-config`, `.github`,
 * `AGENTS.md`, `CLAUDE.md`, ...) as anywhere else in a checkout: reading configuration changes
 * nothing. Writes, and reads of credential and secret files, still go to a person.
 *
 * A plain read is tight on purpose: one of a few reading programs (or the Read tool), joined only by
 * `&&`, `||`, `;` and pipes into another reading program; no command substitution, variables,
 * assignments, globs, here-documents or redirections other than `2>/dev/null`, `2>&1` and `<` from a
 * file; no option that runs a program or writes a file. Every named path must be inside a Git
 * checkout or under a protected directory, and none may be a secret.
 */
const READERS = new Set(["cat", "ls", "grep", "egrep", "fgrep", "rg", "head", "tail", "find"]);
/** Options that run a program or write a file. */
const UNSAFE_OPTIONS: Record<string, RegExp> = {
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  rg: /^--pre(?:-glob)?(?:=|$)/,
  git: /^(?:-O|--open-files-in-pager|--ext-diff|--textconv)/,
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

/** A path word a plain read may name: inside a checkout or a protected directory, and no secret. */
function readable(cwd: string, word: string): boolean {
  if (secretPath(word)) return false;
  let lexical: string;
  try {
    lexical = resolveWord(cwd, word);
  } catch {
    return false;
  }
  let real = lexical;
  try {
    real = canonical(lexical);
  } catch {
    /* judged as written */
  }
  if (secretPath(lexical) || secretPath(real)) return false;
  return inCheckout(real) || protectedPath(real) || protectedPath(lexical);
}

/** The words of a reading command that may name files: everything but its options. */
function operands(argv: string[]): string[] | undefined {
  const [program = "", ...args] = argv;
  const unsafe = UNSAFE_OPTIONS[program];
  const words: string[] = [];
  for (const arg of args) {
    if (unsafe?.test(arg)) return undefined;
    if (arg.startsWith("-")) {
      // `--file=x`, `-fx`: a value attached to an option can be a path.
      const value = arg.startsWith("--") ? arg.split("=").slice(1).join("=") : "";
      if (value) words.push(value);
      continue;
    }
    words.push(arg);
  }
  return words;
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
      if (cmd.loose?.some(Boolean) || cmd.glob?.some(Boolean)) return false;
      const program = cmd.argv[0] ?? "";
      if (program === "cd" && pipeline.length === 1) {
        const target = cmd.argv[1];
        if (cmd.argv.length !== 2 || !target || target.startsWith("-") || cmd.redirects.length)
          return false;
        for (const dir of [...cwds]) {
          const next = resolveSafe(dir, target);
          if (next === "\0") return false;
          cwds.add(next);
        }
        if (cwds.size > 4) return false;
        continue;
      }
      const gitGrep = program === "git" && cmd.argv[1] === "grep";
      if (!READERS.has(program) && !gitGrep) return false;
      const words = operands(gitGrep ? ["git", ...cmd.argv.slice(2)] : cmd.argv);
      if (!words) return false;
      for (const redirect of cmd.redirects) {
        if (redirect.op === ">&" && redirect.target === "1" && redirect.fd === "2") continue;
        if (redirect.op === ">" && redirect.fd === "2" && redirect.target === "/dev/null") continue;
        if (redirect.op === "<") {
          words.push(redirect.target);
          continue;
        }
        return false;
      }
      // A reader with no path searches or lists the directory it runs in.
      for (const cwd of cwds) if (!readable(cwd, ".")) return false;
      for (const word of words)
        for (const cwd of cwds) {
          // `git grep` revisions and pathspecs (`origin/main`, `--`) name no file to read here.
          if (gitGrep && (word === "--" || !existsSync(resolveSafe(cwd, word)))) {
            if (secretPath(word)) return false;
            continue;
          }
          if (++checked > 32 || !readable(cwd, word)) return false;
        }
    }
  return true;
}

function resolveSafe(cwd: string, word: string): string {
  try {
    return resolveWord(cwd, word);
  } catch {
    return "\0";
  }
}
