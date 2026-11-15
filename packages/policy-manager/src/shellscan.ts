/**
 * A lenient shell scanner for the `alwaysAsk` hard list. Unlike the policy parser it never
 * refuses a script: it removes quotes and backslashes, splits at operators, and opens command and
 * process substitutions as commands of their own, so `'git' push --for"ce"` and
 * `git $(echo push) --force` are seen as the words the shell would run. It decides nothing alone:
 * it only names hard-list rules a decision that already needs a person falls under, so a false
 * match asks rather than approves.
 */

/** One word after quote removal. `literal` is false when it holds an expansion or substitution. */
export interface Word {
  text: string;
  literal: boolean;
  /** The target of a redirection (`>`, `>>`, `<`, `<<<`, ...). */
  redirect?: boolean;
  /** Holds an unquoted expansion or substitution, which can split into words and options. */
  bare?: boolean;
}

export interface Scan {
  segments: Word[][];
  /** False when a quote or substitution was left open: the script could not be read fully. */
  complete: boolean;
}

interface Frame {
  segment: Word[];
  text: string;
  active: boolean;
  literal: boolean;
  bare: boolean;
  closer: ")" | "`";
  /** The substitution opened inside double quotes, which resume after it. */
  quoted: boolean;
}

export function scan(script: string): Scan {
  const segments: Word[][] = [];
  const stack: Frame[] = [];
  let segment: Word[] = [];
  let text = "";
  let active = false;
  let literal = true;
  let bare = false;
  let redirectNext = false;
  let quote: "" | "'" | '"' = "";
  const endWord = () => {
    if (active) {
      segment.push({
        text,
        literal,
        ...(redirectNext ? { redirect: true } : {}),
        ...(bare ? { bare: true } : {}),
      });
      redirectNext = false;
    }
    text = "";
    active = false;
    literal = true;
    bare = false;
  };
  const endSegment = () => {
    endWord();
    if (segment.length) segments.push(segment);
    segment = [];
  };
  /** Opens a substitution: its body is read as commands, and the outer word is not literal. */
  const open = (closer: ")" | "`") => {
    stack.push({
      segment,
      text,
      active: true,
      literal: false,
      bare: bare || quote !== '"',
      closer,
      quoted: quote === '"',
    });
    segment = [];
    text = "";
    active = false;
    literal = true;
    bare = false;
    quote = "";
  };
  const close = () => {
    endSegment();
    const frame = stack.pop() as Frame;
    segment = frame.segment;
    text = `${frame.text}$`;
    active = frame.active;
    literal = frame.literal;
    bare = frame.bare;
    quote = frame.quoted ? '"' : "";
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i] as string;
    const next = script[i + 1];
    if (quote === "'") {
      if (c === "'") quote = "";
      else text += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && next !== undefined && /[$`"\\\n]/.test(next)) text += script[++i];
      else if (c === "$" && next === "(") {
        // The body of "$(...)" runs too; read it as commands and resume the quoted word after it.
        i++;
        open(")");
      } else if (c === "`") open("`");
      else {
        if (c === "$") literal = false;
        text += c;
      }
      continue;
    }
    if (c === "\\") {
      if (next === "\n") i++;
      else if (next !== undefined) {
        text += script[++i];
        active = true;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      active = true;
      continue;
    }
    if (c === "#" && !active) {
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "$" && (next === "(" || next === "{")) {
      if (next === "(") {
        i++;
        open(")");
      } else {
        literal = false;
        bare = true;
        active = true;
        text += c;
      }
      continue;
    }
    if (c === "$") {
      literal = false;
      bare = true;
      active = true;
      text += c;
      continue;
    }
    if (c === "`") {
      if (stack.at(-1)?.closer === "`") close();
      else open("`");
      continue;
    }
    if (c === ")" && stack.at(-1)?.closer === ")") {
      close();
      continue;
    }
    if (c === ">" || c === "<") {
      if (/^\d+$/.test(text)) {
        text = "";
        active = false;
      }
      endWord();
      // `<(cmd)` and `>(cmd)` are process substitutions: their bodies are commands.
      if (next === "(") {
        i++;
        open(")");
        continue;
      }
      while (/[<>|&]/.test(script[i + 1] ?? "")) i++;
      redirectNext = true;
      continue;
    }
    if (c === "&" && next === ">") continue;
    if (/[;&|()\n]/.test(c)) {
      endSegment();
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    text += c;
    active = true;
  }
  const complete = quote === "" && stack.length === 0;
  while (stack.length) close();
  endSegment();
  return { segments, complete };
}

/** Programs that run the rest of their words as a command, with the options each takes a value for. */
const WRAPPERS: Record<string, string[]> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
  sudo: ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D"],
  doas: ["-u", "-C"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nohup: [],
  time: [],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "-t"],
  stdbuf: ["-i", "-o", "-e"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  xargs: ["-I", "-n", "-L", "-P", "-d", "-s", "-E", "-a", "--arg-file", "--delimiter"],
  nocorrect: [],
  noglob: [],
};
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

export interface Command {
  /** Assignments before the program (`GIT_DIR=x git ...`), with wrapper `env` assignments. */
  assignments: Word[];
  program?: Word;
  args: Word[];
  redirects: Word[];
}

function basenameOf(text: string): string {
  return text.split(/[\\/]/).pop() ?? text;
}

/** The program and arguments of one segment, behind assignments, keywords and wrappers. */
export function command(segment: Word[]): Command {
  const redirects = segment.filter((word) => word.redirect);
  const words = segment.filter((word) => !word.redirect);
  const assignments: Word[] = [];
  let i = 0;
  for (let depth = 0; depth < 8; depth++) {
    while (i < words.length && ASSIGNMENT.test(words[i]?.text ?? ""))
      assignments.push(words[i++] as Word);
    while (i < words.length && KEYWORDS.has(words[i]?.text ?? "")) i++;
    const name = basenameOf(words[i]?.text ?? "");
    if (!words[i]?.literal || !(name in WRAPPERS)) break;
    const valued = WRAPPERS[name] as string[];
    i++;
    while (i < words.length) {
      const word = words[i] as Word;
      if (word.text === "--") {
        i++;
        break;
      }
      if (name === "env" && ASSIGNMENT.test(word.text)) assignments.push(word);
      else if (name === "timeout" && /^[0-9.]+[smhd]?$/.test(word.text)) {
        i++;
        break;
      } else if (!word.text.startsWith("-")) break;
      else if (valued.includes(word.text)) i++;
      i++;
    }
  }
  return { assignments, program: words[i], args: words.slice(i + 1), redirects };
}

/** The script a shell or `eval` runs, when the segment is one: `bash -c '...'`, `eval ...`. */
export function innerScript(cmd: Command): { script: string; literal: boolean } | undefined {
  const program = cmd.program;
  if (!program?.literal) return undefined;
  const name = basenameOf(program.text);
  if (name === "eval")
    return {
      script: cmd.args.map((word) => word.text).join(" "),
      literal: cmd.args.every((word) => word.literal),
    };
  if (!SHELLS.has(name)) return undefined;
  const flag = cmd.args.findIndex(
    (word) => /^-[a-zA-Z]+$/.test(word.text) && word.text.includes("c"),
  );
  if (flag < 0) return undefined;
  const body = cmd.args.slice(flag + 1).find((word) => !word.text.startsWith("-"));
  return body ? { script: body.text, literal: body.literal } : undefined;
}
