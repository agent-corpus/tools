/**
 * A lenient shell scanner for the hard human list and for matching the user's own permission
 * rules. Unlike the policy parser it never refuses a script: it removes quotes and backslashes,
 * splits at operators, and opens command and process substitutions as commands of their own, so
 * `'git' push --for"ce"` and `git $(echo push) --force` are seen as the words the shell would run.
 * It decides nothing alone: a false match on the hard list asks rather than approves, and a user
 * allow rule only matches a script the scanner read completely with literal words.
 */

/** One word after quote removal. `literal` is false when it holds an expansion or substitution. */
export interface Word {
  text: string;
  literal: boolean;
  /** The target of a redirection (`>`, `>>`, `<`, `<<<`, ...). */
  redirect?: boolean;
  /** Holds an unquoted expansion or substitution, which can split into words and options. */
  bare?: boolean;
  /** The body of a here-document fed to this command's standard input (also `redirect`). */
  heredoc?: boolean;
  /** A here-document with a quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`): nothing expands. */
  quoted?: boolean;
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
  /** The next word is a here-document delimiter (`<<` or `<<-`). */
  let delimiterNext: "" | "<<" | "<<-" = "";
  /** Here-documents whose bodies start after the next newline, with the command they feed. */
  let pending: Array<{ delimiter: string; strip: boolean; quoted: boolean; segment: Word[] }> = [];
  /** The current word had a quote or a backslash escape in it (a quoted here-document delimiter). */
  let wordQuoted = false;
  let unterminated = false;
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
      if (delimiterNext) {
        pending.push({
          delimiter: text,
          strip: delimiterNext === "<<-",
          quoted: wordQuoted,
          segment,
        });
        delimiterNext = "";
      }
    }
    text = "";
    wordQuoted = false;
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
        wordQuoted = true;
        active = true;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      wordQuoted = true;
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
      // `<<` and `<<-` start a here-document (`<<<` is a here-string, an ordinary word).
      const heredoc =
        c === "<" && next === "<" && script[i + 2] !== "<"
          ? script[i + 2] === "-"
            ? "<<-"
            : "<<"
          : "";
      while (/[<>|&-]/.test(script[i + 1] ?? "") && (script[i + 1] !== "-" || heredoc)) i++;
      redirectNext = true;
      if (heredoc) delimiterNext = heredoc;
      continue;
    }
    if (c === "&" && next === ">") continue;
    if (c === "\n" && (pending.length || delimiterNext)) endWord();
    if (c === "\n" && pending.length) {
      // The bodies follow, in order, each up to a line that is exactly its delimiter.
      endSegment();
      for (const doc of pending) {
        const lines: string[] = [];
        let found = false;
        while (i + 1 < script.length) {
          const end = script.indexOf("\n", i + 1);
          const line = script.slice(i + 1, end < 0 ? script.length : end);
          i = end < 0 ? script.length - 1 : end;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
            found = true;
            break;
          }
          lines.push(line);
        }
        if (!found) unterminated = true;
        const body = lines.join("\n");
        doc.segment.push({
          text: body,
          literal: true,
          redirect: true,
          heredoc: true,
          ...(doc.quoted ? { quoted: true } : {}),
        });
        // With an unquoted delimiter the shell expands `$(...)`, backticks and `${...}` in the
        // body, as in a double-quoted string: those substitutions run, so they are commands here.
        if (!doc.quoted && /[$`]/.test(body)) {
          // In the body a `"` and a backslash before it are literal; in a double-quoted string
          // they must be escaped (`"` as `\"`, that backslash as `\\`). Other backslashes mean the
          // same in both (they escape `$`, a backtick, `\` and a newline, and are otherwise kept).
          const quoted = body.replace(/\\(?=")|"/g, (match) => (match === '"' ? '\\"' : "\\\\"));
          const inner = scan(`"${quoted}"`);
          if (!inner.complete) unterminated = true;
          // The last segment is the body itself as one word; the others are its substitutions.
          segments.push(...inner.segments.slice(0, -1));
        }
      }
      pending = [];
      continue;
    }
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
  const complete = quote === "" && stack.length === 0 && !unterminated && !pending.length;
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
  watch: ["-n", "--interval", "-q", "--equexit"],
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
