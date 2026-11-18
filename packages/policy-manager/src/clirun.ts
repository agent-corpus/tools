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
/**
 * The CLI's subcommands that grant or record a decision, and no common program uses: after a
 * computed program word, they are the CLI. Other words (`$GIT config`, `"$DOCKER" stop`) fall to
 * the computed-program rule, which sends the command to the classifier, then a person.
 */
const CLI_SUBCOMMAND = /^(?:approve|record|classify)$/;
/** Whether `words` start with a computed program followed by a CLI subcommand (`$p$q approve`). */
const computedCli = (words: Word[]) =>
  !!words[0] && !words[0].literal && !!words[1]?.literal && CLI_SUBCOMMAND.test(words[1].text);

const basename = (text: string) => text.split(/[\\/]/).pop() ?? text;
/** An assignment the scanner split at a substitution (`V=$(npm view x)`): not a program. */
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;
/** Interpreters whose code is not shell: their words are code and data, not programs. */
const CODE_INTERPRETER = /^(?:python[\d.]*|perl|ruby|node|nodejs|bun|deno|php)(?:\.exe)?$/i;
/**
 * Code that can start a process or evaluate a string: only such code can run the CLI. Backticks
 * run a command in Perl, Ruby and PHP; in JavaScript they are template strings.
 */
const SPAWNS =
  /child_process|subprocess|\bspawn|\bexec(?:Sync|File\w*|[lv]p?e?)?\s*\(|\bsystem\s*\(|\bsystem\s+["'$]|\bpopen|Popen|\bpty\b|\bcommands\s*\.|shell_exec|passthru|proc_open|\bqx\b|%x[({[]|\bIO\s*\.\s*popen|Bun\s*\.\s*(?:spawn|\$)|Deno\s*\.\s*(?:run|Command)|\beval\b|\bFunction\s*\(|\bvm\s*\.|\bWorker\s*\(|__import__|importlib|\bgetattr\s*\(|\bcompile\s*\(|\brequire\s*\(\s*[^'"\s)]|\bimport\s*\(\s*[^'"\s)]|\bos\s*\.\s*(?:system|popen|exec|spawn|posix_spawn|fork)/;
const BACKTICK_RUNS = /^(?:perl|ruby|php)/i;
/** Code that loads the package itself (`import(".../@agent-corpus/policy-manager/dist/x.js")`). */
const LOADS_PACKAGE =
  /(?:\b(?:import|require)\s*\(?|\bfrom)\s*["'`][^"'`]*(?:@agent-corpus[\\/]policy-manager[\\/]|policy-manager[\\/]dist[\\/])/gi;
/**
 * The code with the text of its string literals removed (`'...'`, `"..."`, Python's triple
 * quotes, and JavaScript templates except their `${...}` parts), so words in data (a message that
 * mentions `spawn`) are not read as calls. Perl, Ruby and PHP backticks are commands: kept.
 */
export function withoutStrings(code: string, interpreter = ""): string {
  return stringText(code, interpreter, false);
}
/**
 * The code with the text of its string literals replaced by spaces, so every position still lines
 * up with the code: a match found here is outside any string.
 */
export function maskStrings(code: string, interpreter = ""): string {
  return stringText(code, interpreter, true);
}
function stringText(code: string, interpreter: string, keepLength: boolean): string {
  const backtickCode = BACKTICK_RUNS.test(interpreter);
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i] as string;
    const triple = (c === '"' || c === "'") && code.startsWith(c.repeat(3), i);
    if (!triple && c !== '"' && c !== "'" && (c !== "`" || backtickCode)) {
      out += c;
      continue;
    }
    const close = triple ? c.repeat(3) : c;
    const start = out.length;
    out += close;
    let j = i + close.length;
    for (; j < code.length; j++) {
      if (code[j] === "\\") {
        if (keepLength) out += code[j + 1] === "\n" ? " \n" : "  ";
        j++;
        continue;
      }
      if (c === "`" && code.startsWith("${", j)) {
        // A template substitution is code: keep it, up to its closing brace.
        let depth = 0;
        for (; j < code.length; j++) {
          out += code[j];
          if (code[j] === "{") depth++;
          else if (code[j] === "}" && --depth === 0) break;
        }
        continue;
      }
      if (code.startsWith(close, j)) break;
      if (!triple && c !== "`" && code[j] === "\n") break; // an unclosed quote ends at the line
      if (keepLength) out += code[j] === "\n" ? "\n" : " ";
    }
    if (keepLength) out = out.padEnd(start + (j - i), " ");
    out += code.slice(j, j + close.length);
    i = j + close.length - 1;
  }
  return out;
}

/** Whether interpreter code can start a process or evaluate a string. */
function codeSpawns(code: string, interpreter: string): boolean {
  const bare = withoutStrings(code, interpreter);
  return SPAWNS.test(bare) || (BACKTICK_RUNS.test(interpreter) && bare.includes("`"));
}
/**
 * Whether interpreter code runs the CLI: it loads the package, or it can start a process and
 * names the CLI anywhere (a read-only subcommand is allowed only as a literal shell command).
 */
function codeRuns(code: string, interpreter: string, cliPath: string | undefined): boolean {
  // An import or require of the package, written as code rather than inside a string.
  const masked = maskStrings(code, interpreter);
  for (const match of code.matchAll(LOADS_PACKAGE))
    if (masked[match.index ?? 0] === code[match.index ?? 0]) return true;
  if (cliPath && code.includes(cliPath)) return true;
  return codeSpawns(code, interpreter) && NAMES_CLI.test(code);
}

/** Whether `argv` (after the program) is an allowed read-only invocation, written literally. */
export function readOnlyCliArgs(words: Word[]): boolean {
  if (words.some((word) => !word.literal || EXPANDS.test(word.text))) return false;
  const argv = words.map((word) => word.text);
  const [sub, ...rest] = argv;
  if (argv.length === 1 && (sub === "--help" || sub === "--version" || sub === "help")) return true;
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
  // Any file of the installed package runs its code, except data and docs (`package.json`).
  return (
    /(?:^|\/)policy-manager\/dist\/cli\.js$/i.test(slashed) ||
    (/@agent-corpus\/policy-manager\//i.test(slashed) &&
      !/\.(?:json|md|map|d\.ts|txt)$|\/LICENSE$/i.test(slashed))
  );
}

/** The arguments after a CLI program word, or undefined when `words` do not start the CLI. */
function cliArgs(words: Word[], cliPath: string | undefined): Word[] | undefined {
  const [program, ...args] = words;
  if (!program) return undefined;
  const name = basename(program.text);
  if (CLI_NAME.test(name) || isCliFile(program.text, cliPath)) return args;
  // Any `cli.js` given a subcommand only this CLI has (`/opt/pm/dist/cli.js approve`).
  const subcommand = (rest: Word[]) => !!rest[0]?.literal && CLI_SUBCOMMAND.test(rest[0].text);
  if (/cli\.js$/i.test(name) && subcommand(args)) return args;
  if (NODE.test(name)) {
    // `node -e <code>` and `node -p <code>` run the code, not a file.
    const code = args.findIndex((word) => /^(?:-e|-p|--eval|--print)$/.test(word.text));
    if (code >= 0) return undefined;
    const file = args.findIndex((word) => !word.text.startsWith("-"));
    if (file >= 0 && isCliFile(args[file]?.text ?? "", cliPath)) return args.slice(file + 1);
    if (file >= 0 && /cli\.js$/i.test(args[file]?.text ?? "") && subcommand(args.slice(file + 1)))
      return args.slice(file + 1);
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
    if (program && ASSIGNMENT.test(program.text)) continue;
    if (program && !program.literal && NAMES_CLI.test(script)) return true;
    if (program && computedCli([program, ...cmd.args])) return true;
    // A script file whose name is computed, in a script that names the CLI (`node $C setup-hook`).
    if (program?.literal && CODE_INTERPRETER.test(basename(program.text))) {
      const inline = cmd.args.some((word) => /^(?:-[ceEp]|--eval|--print)$/.test(word.text));
      const file = cmd.args.find((word) => !word.text.startsWith("-"));
      if (!inline && file && !file.literal && NAMES_CLI.test(script)) return true;
    }
    if (program && wordsRun([program, ...cmd.args], cliPath, depth)) return true;
    const inner = innerScript(cmd);
    if (inner && scriptRuns(inner.script, cliPath, depth + 1)) return true;
    // A here-document or here-string fed to a shell or an interpreter is code.
    const name = basename(program?.text ?? "");
    if (SHELL_OR_INTERPRETER.test(name))
      for (const doc of segment.filter((word) => word.heredoc || word.herestring))
        if (
          CODE_INTERPRETER.test(name)
            ? codeRuns(doc.text, name, cliPath)
            : scriptRuns(doc.text, cliPath, depth + 1)
        )
          return true;
  }
  return false;
}

/**
 * Whether `words` run the CLI: they start it, or a wrapper or runner among them reaches it. A
 * runner's remaining words are read from each position, and each one as a script of its own
 * (`expect -c 'spawn pm ...'`, `script -q /dev/null pm ...`, `tmux new 'pm ...'`).
 */
function wordsRun(words: Word[], cliPath: string | undefined, depth: number): boolean {
  if (computedCli(words)) return true;
  const args = cliArgs(words, cliPath);
  // A literal `classify` is a classification record: the session sends any record but its own
  // exact one to a person by that rule (`foreign-classification-record`).
  if (args) return !readOnlyCliArgs(args) && !(args[0]?.literal && args[0].text === "classify");
  const name = basename(words[0]?.text ?? "");
  if (!RUNS_REST.has(name) && !SHELL_OR_INTERPRETER.test(name)) return false;
  if (depth > MAX_DEPTH) return words.some((word) => NAMES_CLI.test(word.text));
  // Interpreter code: its words are code and data. It runs the CLI only by loading the package
  // or by starting a process.
  if (CODE_INTERPRETER.test(name))
    return words
      .slice(1)
      .some((word) => /\s/.test(word.text) && codeRuns(word.text, name, cliPath));
  for (let i = 1; i < words.length; i++) {
    if (wordsRun(words.slice(i), cliPath, depth + 1)) return true;
    const text = words[i]?.text ?? "";
    if (/\s/.test(text) && scriptRuns(text, cliPath, depth + 1)) return true;
  }
  return false;
}

/**
 * Whether a shell script runs a program whose name is computed at run time: a program word with a
 * variable, `${...}`, `$(...)`, backticks or a quoted piece joined to one (`$p$q`, `${a}m`,
 * `$p'm'`), behind assignments and wrappers, through a runner's remaining words (`script -q
 * /dev/null $p$q ...`), in subshells, `sh -c`/`eval` bodies and here-documents fed to a shell.
 * The engine never approves such a command: what runs cannot be known before it runs.
 */
export function computesProgram(script: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  const { segments } = scan(script);
  for (const segment of segments) {
    const cmd = command(segment);
    const program = cmd.program;
    // An assignment the scanner splits at a substitution (`V=$(date)`) is not a program.
    if (!program || /^[A-Za-z_]\w*\+?=/.test(program.text)) continue;
    if (!program.literal) return true;
    const name = basename(program.text);
    if (RUNS_REST.has(name) && cmd.args.some((word) => !word.literal && !word.text.startsWith("-")))
      return true;
    if (RUNS_REST.has(name))
      for (const word of cmd.args)
        if (/\s/.test(word.text) && computesProgram(word.text, depth + 1)) return true;
    const inner = innerScript(cmd);
    if (inner && (!inner.literal || computesProgram(inner.script, depth + 1))) return true;
    if (SHELL_OR_INTERPRETER.test(name))
      for (const doc of segment.filter((word) => word.heredoc || word.herestring))
        if (
          /^(?:sh|bash|zsh|dash|ksh|mksh|fish)(?:\.exe)?$/i.test(name) &&
          computesProgram(doc.text, depth + 1)
        )
          return true;
  }
  return false;
}

/** Whether a shell script runs the policy-manager CLI other than an allowed read-only form. */
export function runsPolicyCli(script: string, cliPath?: string): boolean {
  return scriptRuns(script, cliPath, 0);
}

/** Wrappers whose next word is the command they run. */
const LEADS = new Set(["env", "sudo", "exec", "nohup", "time", "xargs", "script", "start", "cmd"]);
/**
 * Whether a word in command position is a Windows path to the CLI (`C:\\bin\\pm.cmd`), which the
 * scanner cannot read because it drops backslashes. Linear: one split, then each piece's words.
 */
function windowsCli(script: string): boolean {
  for (const piece of script.split(/[\n;&|(`]/)) {
    for (const raw of piece.split(/\s+/)) {
      const word = raw.replace(/^["']|["']$/g, "");
      if (!word) continue;
      if (word.includes("\\") && CLI_NAME.test(word.slice(word.lastIndexOf("\\") + 1))) return true;
      if (!LEADS.has(word) && !word.startsWith("-") && !/^[A-Za-z_]\w*=/.test(word)) break;
    }
  }
  return false;
}
const SHELL_NAME = /^(?:sh|bash|zsh|dash|ksh|mksh|fish|source|\.)(?:\.exe)?$/i;
/** Programs that build a command from their input or arguments, out of the scanner's sight. */
const COMPOSERS = new Set(["xargs", "parallel", "eval", "watch", "tmux", "screen", "ssh"]);

/**
 * Whether a script runs code whose commands the scan cannot follow: a shell reading a file or its
 * standard input, a program run by path, a composer (`xargs`, `eval`, `find -exec`), a computed
 * program, interpreter code that can start a process, or a script that cannot be read. Only then
 * can text that merely names `approve` with the CLI (`looksLikeApproveGrant`) be a command.
 */
export function hidesCode(script: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  // The scanner drops backslashes, so a Windows path to the CLI (`C:\\bin\\pm.cmd`) is read here.
  // Only a word in command position counts: at the start of a line or after an operator, a
  // wrapper or a quote that opens a command string.
  if (windowsCli(script)) return true;
  const { segments, complete } = scan(script);
  if (!complete) return true;
  // Files a here-document writes are code once something runs them.
  const docs = segments.flatMap((segment) =>
    segment.filter((word) => word.heredoc || word.herestring).map((word) => word.text),
  );
  for (const segment of segments) {
    const cmd = command(segment);
    const program = cmd.program;
    if (!program || ASSIGNMENT.test(program.text)) continue;
    if (!program.literal) return true;
    const name = basename(program.text);
    if (/[\\/]/.test(program.text) && !CLI_NAME.test(name)) return true;
    if (COMPOSERS.has(name)) return true;
    if (name === "find" && cmd.args.some((word) => /^-(?:exec|execdir|ok|okdir)$/.test(word.text)))
      return true;
    if (SHELL_NAME.test(name)) {
      const inner = innerScript(cmd);
      if (!inner) return true;
      if (!inner.literal || hidesCode(inner.script, depth + 1)) return true;
      continue;
    }
    if (CODE_INTERPRETER.test(name)) {
      const code = [
        ...cmd.args.filter((word) => /\s/.test(word.text)).map((word) => word.text),
        ...docs,
      ];
      if (code.some((text) => codeSpawns(text, name))) return true;
      continue;
    }
    if (SHELL_OR_INTERPRETER.test(name)) return true;
  }
  return false;
}
