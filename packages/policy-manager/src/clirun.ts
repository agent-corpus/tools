import { command, innerScript, scan, type Word } from "./shellscan.js";

/**
 * Whether a shell script runs the policy-manager CLI, by any name: `pm`, `pm.cmd`, a path ending in
 * `/pm` (the launcher), `policy-manager`, `node <...policy-manager...>/cli.js` (or this install's
 * own `cli.js`), `npx`/`npm exec`/`pnpm dlx`/`yarn dlx`/`bunx` of the package. It looks at program
 * words, not text: behind assignments and wrappers (`env`, `sudo`, `nohup`, `timeout`, `xargs`,
 * `script`, `unbuffer`, `setsid`, `expect`'s `spawn`), in subshells, groups and substitutions, in
 * `sh -c`/`eval` bodies and here-documents fed to a shell, backgrounded or not.
 *
 * An agent never runs the CLI: `approve` is the user's, `classify` records are judged on their own.
 * The only exception is a short list of read-only subcommands written fully literally. A program
 * name computed at run time (`$p approve`, `$(which pm)`) counts when the script names the CLI
 * anywhere.
 */

const CLI_NAME = /^(?:pm|policy-manager)(?:\.cmd|\.exe|\.bat|\.ps1)?$/i;
const PACKAGE = /^(?:@agent-corpus\/)?policy-manager(?:@[^\s/]*)?$/i;
/** Text that names the CLI anywhere, for a script whose program word is computed. */
const NAMES_CLI =
  /(?:^|[\s/\\'"`(;|&=])(?:pm(?:\.cmd|\.exe|\.bat|\.ps1)?|policy-manager)(?=$|[\s'"`);|&@])|policy-manager[\\/]dist[\\/]cli\.js|@agent-corpus[\\/]policy-manager/i;
const NODE = /^(?:node|nodejs|bun|deno|tsx|ts-node)(?:\.exe)?$/i;
/** Programs that run the command in their remaining words, after their own options. */
const RUNS_REST = new Set([
  ...["script", "unbuffer", "setsid", "caffeinate", "chronic", "spawn", "nohup", "exec"],
  ...["sudo", "doas", "su", "env", "xargs", "timeout", "time", "nice", "ionice", "stdbuf"],
  ...["watch", "flock", "tmux", "screen", "parallel", "expect", "osascript", "ssh"],
  ...["runuser", "chroot", "systemd-run", "launchctl", "start", "cmd", "powershell", "pwsh"],
]);
const SHELL_OR_INTERPRETER =
  /^(?:sh|bash|zsh|dash|ksh|mksh|fish|expect|tclsh|python[\d.]*|perl|ruby|node)(?:\.exe)?$/i;
/** Something an argument expands at run time: a variable, a substitution, a glob or a brace. */
const EXPANDS = /[$`*?[\]{}]/;
const MAX_DEPTH = 6;

const basename = (text: string) => text.split(/[\\/]/).pop() ?? text;

/** Whether `argv` (after the program) is an allowed read-only invocation, written literally. */
export function readOnlyCliArgs(words: Word[]): boolean {
  if (words.some((word) => !word.literal || EXPANDS.test(word.text))) return false;
  const argv = words.map((word) => word.text);
  const [sub, ...rest] = argv;
  if (argv.length === 1 && (sub === "--help" || sub === "--version")) return true;
  if (sub === "review-classifications")
    return (
      rest.length === 0 ||
      (rest.length === 2 && rest[0] === "--since" && /^[\w:.+-]+$/.test(rest[1] ?? "")) ||
      (rest.length === 1 && /^--since=[\w:.+-]+$/.test(rest[0] ?? ""))
    );
  if (/^setup-hook(?:-(?:claude|codex|copilot))?$/.test(sub ?? ""))
    return rest.includes("--dry-run") && rest.every((word) => /^[\w./:=-]+$/.test(word));
  if (sub === "profile")
    return rest.length === 2 && rest[0] === "validate" && /^[\w./~-]+$/.test(rest[1] ?? "");
  return false;
}

function isCliFile(text: string, cliPath: string | undefined): boolean {
  const slashed = text.replace(/\\/g, "/");
  if (cliPath && slashed === cliPath.replace(/\\/g, "/")) return true;
  return /(?:^|\/)policy-manager\/dist\/cli\.js$|@agent-corpus\/policy-manager\//i.test(slashed);
}

/** The arguments after a CLI program word, or undefined when `words` do not start the CLI. */
function cliArgs(words: Word[], cliPath: string | undefined): Word[] | undefined {
  const [program, ...args] = words;
  if (!program) return undefined;
  const name = basename(program.text);
  if (CLI_NAME.test(name) || isCliFile(program.text, cliPath)) return args;
  if (NODE.test(name)) {
    const file = args.findIndex((word) => !word.text.startsWith("-"));
    if (file >= 0 && isCliFile(args[file]?.text ?? "", cliPath)) return args.slice(file + 1);
    return undefined;
  }
  // npx/bunx <pkg>, npm exec|x <pkg>, pnpm dlx|exec <pkg>, yarn dlx|exec <pkg>.
  const runner =
    /^(?:npx|bunx)(?:\.cmd)?$/i.test(name) ||
    (/^(?:npm|pnpm|yarn)(?:\.cmd)?$/i.test(name) &&
      /^(?:exec|x|dlx)$/.test(args.find((word) => !word.text.startsWith("-"))?.text ?? ""));
  if (runner) {
    const at = args.findIndex((word) => PACKAGE.test(word.text));
    if (at >= 0) {
      const rest = args.slice(at + 1);
      return rest[0]?.text === "--" ? rest.slice(1) : rest;
    }
  }
  return undefined;
}

function scriptRuns(script: string, cliPath: string | undefined, depth: number): boolean {
  if (depth > MAX_DEPTH) return NAMES_CLI.test(script);
  const { segments } = scan(script);
  for (const segment of segments) {
    const cmd = command(segment);
    const program = cmd.program;
    if (program && !program.literal && NAMES_CLI.test(script)) return true;
    if (program && wordsRun([program, ...cmd.args], cliPath, depth)) return true;
    const inner = innerScript(cmd);
    if (inner && scriptRuns(inner.script, cliPath, depth + 1)) return true;
    // A here-document or here-string fed to a shell or an interpreter is code.
    const name = basename(program?.text ?? "");
    if (SHELL_OR_INTERPRETER.test(name))
      for (const doc of segment.filter((word) => word.heredoc || word.herestring))
        if (scriptRuns(doc.text, cliPath, depth + 1)) return true;
  }
  return false;
}

/**
 * Whether `words` run the CLI: they start it, or a wrapper or runner among them reaches it. A
 * runner's remaining words are read from each position, and each one as a script of its own
 * (`expect -c 'spawn pm ...'`, `script -q /dev/null pm ...`, `tmux new 'pm ...'`).
 */
function wordsRun(words: Word[], cliPath: string | undefined, depth: number): boolean {
  const args = cliArgs(words, cliPath);
  // A literal `classify` is a classification record: the session sends any record but its own
  // exact one to a person by that rule (`foreign-classification-record`).
  if (args) return !readOnlyCliArgs(args) && !(args[0]?.literal && args[0].text === "classify");
  const name = basename(words[0]?.text ?? "");
  if (!RUNS_REST.has(name) && !SHELL_OR_INTERPRETER.test(name)) return false;
  if (depth > MAX_DEPTH) return words.some((word) => NAMES_CLI.test(word.text));
  for (let i = 1; i < words.length; i++) {
    if (wordsRun(words.slice(i), cliPath, depth + 1)) return true;
    const text = words[i]?.text ?? "";
    if (/\s/.test(text) && scriptRuns(text, cliPath, depth + 1)) return true;
  }
  return false;
}

/** Whether a shell script runs the policy-manager CLI other than an allowed read-only form. */
export function runsPolicyCli(script: string, cliPath?: string): boolean {
  return scriptRuns(script, cliPath, 0);
}
