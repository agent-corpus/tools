// Parses a bounded subset of POSIX shell into a syntax tree so a caller can judge every command
// that would run. Anything whose effects the caller could not judge is rejected (undefined) and
// falls back to a human: brace expansion, arithmetic, functions, unquoted-delimiter heredocs whose
// bodies expand, `$'...'`, `${X:-y}`, `<&`, `>|`, `<>`, `;&`, `[[` aside (a plain word here).
//
// Understood: simple commands with quoting, escapes, leading `NAME=value` assignments and
// redirections (including quoted-delimiter heredocs and here-strings); pipelines, `&&`, `||`, `;`,
// newlines and `&`; `( ... )`, `{ ...; }`, `for`, `while`, `until`, `if`, `case`; comments;
// `$HOME`; variable references (`$NAME`, `${NAME}`), which are left for the caller to resolve;
// `$(...)`, backticks and `<(...)`/`>(...)`, whose inner commands are returned for the caller to
// judge; and parameters with no knowable value (`$?`, `$#`, `$$`, PIPESTATUS), which are unknown.

import { homedir } from "node:os";

/** Stands for the unknown output of an expansion inside a word. */
export const SUBSTITUTION = "";

/** `${X:-w}`, `${X:+w}`, `${#X}`, `${X#p}`/`${X##p}`/`${X%p}`/`${X%%p}` and `${X:o:l}`. */
export type ParamOp =
  | { kind: "default"; word: string }
  | { kind: "alternate"; word: string }
  | { kind: "length" }
  | { kind: "strip"; suffix: boolean; longest: boolean; pattern: string }
  | { kind: "slice"; offset: number; length?: number };

export interface VarRef {
  /** A variable name, or a positional parameter (`1`..`9`, `@`, `*`). */
  name: string;
  quoted: boolean;
  op?: ParamOp;
}
export interface UnknownPart {
  unknown: true;
  quoted: boolean;
  /** Body of the command substitution it came from, when it did. */
  inner?: string;
}
export type Part = string | VarRef | UnknownPart;

export interface Word {
  parts: Part[];
  /** Command substitution bodies (and process substitutions) inside this word, in order. */
  subs: string[];
  /** True when any part of the word was quoted or escaped. */
  quoted: boolean;
  /** Set when the word is `NAME=value`: the name, with `parts` holding only the value. */
  assign?: string;
  /** True when the word has an unquoted `*`, `?` or `[`: the shell may replace it by file names. */
  glob?: boolean;
}
export interface Redir {
  fd: string;
  op: ">" | ">>" | "<" | ">&" | "<<" | "<<<";
  target?: Word;
  /** Literal body of a heredoc. */
  body?: string;
}

export interface Simple {
  kind: "simple";
  assigns: Array<{ name: string; value: Word }>;
  argv: Word[];
  redirects: Redir[];
}
export interface Subshell {
  kind: "subshell";
  body: ListNode;
  redirects: Redir[];
}
export interface Group {
  kind: "group";
  body: ListNode;
  redirects: Redir[];
}
export interface ForNode {
  kind: "for";
  name: string;
  words: Word[];
  body: ListNode;
  redirects: Redir[];
}
export interface WhileNode {
  kind: "while";
  /** `until`: the body runs while the condition fails. */
  until?: boolean;
  cond: ListNode;
  body: ListNode;
  redirects: Redir[];
}
export interface IfNode {
  kind: "if";
  clauses: Array<{ cond: ListNode; body: ListNode }>;
  otherwise?: ListNode;
  redirects: Redir[];
}
export interface CaseNode {
  kind: "case";
  word: Word;
  branches: Array<{ patterns: Word[]; body: ListNode }>;
  redirects: Redir[];
}
/** `name() { ...; }` or `name() ( ... )`: defines the function, runs nothing. */
export interface FunctionNode {
  kind: "function";
  name: string;
  body: Group | Subshell;
}
export type Command =
  | Simple
  | Subshell
  | Group
  | ForNode
  | WhileNode
  | IfNode
  | CaseNode
  | FunctionNode;
export interface PipelineNode {
  stages: Command[];
  negated: boolean;
}
export interface AndOr {
  first: PipelineNode;
  rest: Array<{ op: "&&" | "||"; node: PipelineNode }>;
}
export interface ListNode {
  items: Array<{ node: AndOr; background: boolean }>;
}

class Reject extends Error {}
const reject = (): never => {
  throw new Reject();
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNKNOWN_PARAMETER = /^(?:PIPESTATUS|pipestatus)(?:\[[0-9@*]+\])?$/;
const MAX_INPUT = 200_000;
const MAX_DEPTH = 6;
const MAX_NODES = 400;

// --- scanning helpers -------------------------------------------------------------------------

function closingBacktick(command: string, start: number): number | undefined {
  for (let j = start; j < command.length; j++) {
    if (command[j] === "\\") j++;
    else if (command[j] === "`") return j;
  }
  return undefined;
}

/** Body of a backtick substitution: backslash escapes `\``, `\\` and `\$` are removed first. */
function backtickBody(raw: string): string {
  return raw.replace(/\\([`\\$])/g, "$1");
}

/** Reads a heredoc delimiter word starting at `at`. */
function heredocDelimiter(
  command: string,
  at: number,
): { delimiter: string; quoted: boolean; next: number } | undefined {
  let i = at;
  while (command[i] === " " || command[i] === "\t") i++;
  let delimiter = "";
  let quoted = false;
  const start = i;
  while (i < command.length && !/[\s;|&<>()]/.test(command[i] as string)) {
    const c = command[i] as string;
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end < 0) return undefined;
      delimiter += command.slice(i + 1, end);
      quoted = true;
      i = end + 1;
    } else if (c === "\\") {
      if (i + 1 >= command.length || command[i + 1] === "\n") return undefined;
      delimiter += command[i + 1];
      quoted = true;
      i += 2;
    } else if (c === "$" || c === "`") {
      return undefined; // an expanding delimiter is not worth modelling
    } else {
      delimiter += c;
      i++;
    }
  }
  if (i === start || !delimiter) return undefined;
  return { delimiter, quoted, next: i };
}

function heredocBody(
  command: string,
  start: number,
  delimiter: string,
  strip: boolean,
): { body: string; next: number } | undefined {
  const lines: string[] = [];
  let pos = start;
  while (pos <= command.length) {
    const newline = command.indexOf("\n", pos);
    const raw = newline < 0 ? command.slice(pos) : command.slice(pos, newline);
    const line = strip ? raw.replace(/^\t+/, "") : raw;
    if (line === delimiter)
      return { body: lines.join("\n"), next: newline < 0 ? command.length : newline + 1 };
    if (newline < 0) return undefined;
    lines.push(line);
    pos = newline + 1;
  }
  return undefined;
}

/** Index of the `)` that closes a `$(` whose body starts at `start`, honouring quotes and nesting. */
function closingParen(command: string, start: number): number | undefined {
  let depth = 1;
  let j = start;
  const here: Array<{ delimiter: string; strip: boolean }> = [];
  while (j < command.length) {
    const c = command[j] as string;
    if (c === "\\") j += 2;
    else if (c === "'") {
      const end = command.indexOf("'", j + 1);
      if (end < 0) return undefined;
      j = end + 1;
    } else if (c === '"') {
      j++;
      while (j < command.length && command[j] !== '"') {
        const d = command[j] as string;
        if (d === "\\") j += 2;
        else if (d === "$" && command[j + 1] === "(") {
          const end = closingParen(command, j + 2);
          if (end === undefined) return undefined;
          j = end + 1;
        } else if (d === "`") {
          const end = closingBacktick(command, j + 1);
          if (end === undefined) return undefined;
          j = end + 1;
        } else j++;
      }
      if (j >= command.length) return undefined;
      j++;
    } else if (c === "`") {
      const end = closingBacktick(command, j + 1);
      if (end === undefined) return undefined;
      j = end + 1;
    } else if (c === "<" && command[j + 1] === "<" && command[j + 2] !== "<") {
      const strip = command[j + 2] === "-";
      const read = heredocDelimiter(command, j + (strip ? 3 : 2));
      if (!read) return undefined;
      here.push({ delimiter: read.delimiter, strip });
      j = read.next;
    } else if (c === "\n" && here.length) {
      let at = j + 1;
      for (const h of here.splice(0)) {
        const body = heredocBody(command, at, h.delimiter, h.strip);
        if (!body) return undefined;
        at = body.next;
      }
      j = at;
    } else {
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
      j++;
    }
  }
  return undefined;
}

type Expansion =
  | { kind: "text"; text: string; next: number; quoted?: boolean }
  | { kind: "var"; name: string; next: number; op?: ParamOp }
  | { kind: "unknown"; next: number; inner?: string };

/** No leading `=`: zsh's EQUALS option expands `=cmd` to a command path. */
const PARAM_WORD = /^(?:[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*)?$/;
const PARAM_PATTERN = /^[A-Za-z0-9_@%+=:,./*?-]+$/;

/** The name and operation inside `${...}`, or undefined for a form that is not modelled. */
function parameter(body: string): { name: string; op?: ParamOp } | undefined {
  const NAME_OR_POSITION = "([A-Za-z_][A-Za-z0-9_]*|[1-9][0-9]*)";
  let m = new RegExp(`^${NAME_OR_POSITION}$`).exec(body);
  if (m) return { name: m[1] as string };
  m = new RegExp(`^#${NAME_OR_POSITION}$`).exec(body);
  if (m) return { name: m[1] as string, op: { kind: "length" } };
  m = new RegExp(`^${NAME_OR_POSITION}(:?)([-+])(.*)$`).exec(body);
  if (m && PARAM_WORD.test(m[4] as string))
    return {
      name: m[1] as string,
      op: { kind: m[3] === "-" ? "default" : "alternate", word: m[4] as string },
    };
  m = new RegExp(`^${NAME_OR_POSITION}(##?|%%?)(.*)$`).exec(body);
  if (m && PARAM_PATTERN.test(m[3] as string)) {
    const op = m[2] as string;
    return {
      name: m[1] as string,
      op: {
        kind: "strip",
        suffix: op.startsWith("%"),
        longest: op.length === 2,
        pattern: m[3] as string,
      },
    };
  }
  m = new RegExp(`^${NAME_OR_POSITION}:([0-9]+)(?::([0-9]+))?$`).exec(body);
  if (m)
    return {
      name: m[1] as string,
      op: {
        kind: "slice",
        offset: Number(m[2]),
        ...(m[3] === undefined ? {} : { length: Number(m[3]) }),
      },
    };
  return undefined;
}

function globRegex(pattern: string): RegExp {
  const source = [...pattern]
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, "s");
}

/**
 * Applies a parameter operation to a value that is set and not empty, which is the only kind of
 * value the evaluator knows.
 */
export function applyParamOp(value: string, op: ParamOp | undefined): string {
  if (!op || op.kind === "default") return value;
  if (op.kind === "alternate") return op.word;
  if (op.kind === "length") return String([...value].length);
  if (op.kind === "slice")
    return value.slice(op.offset, op.length === undefined ? undefined : op.offset + op.length);
  const regex = globRegex(op.pattern);
  const lengths = [...Array(value.length + 1).keys()];
  if (op.longest) lengths.reverse();
  for (const n of lengths) {
    const piece = op.suffix ? value.slice(value.length - n) : value.slice(0, n);
    if (regex.test(piece)) return op.suffix ? value.slice(0, value.length - n) : value.slice(n);
  }
  return value;
}

const ANSI_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
  "?": "?",
};

/**
 * `$'...'` starting at `command[at] === "$"`. `\'` is refused so that the plain single-quote scan
 * used to find the end of a substitution agrees with the shell; so are NUL, `\c`, `\u` and `\U`.
 */
function ansiString(command: string, at: number): Expansion | undefined {
  let text = "";
  for (let i = at + 2; i < command.length; i++) {
    const c = command[i] as string;
    if (c === "'") {
      if (text.includes(SUBSTITUTION) || text.includes("\0")) return undefined;
      return { kind: "text", text, next: i + 1, quoted: true };
    }
    if (c !== "\\") {
      text += c;
      continue;
    }
    const e = command[i + 1];
    if (e === undefined || e === "'" || e === "c" || e === "u" || e === "U") return undefined;
    const known = ANSI_ESCAPES[e];
    if (known !== undefined) {
      text += known;
      i++;
      continue;
    }
    const hex = e === "x" ? /^[0-9A-Fa-f]{1,2}/.exec(command.slice(i + 2)) : null;
    const octal = /^[0-7]{1,3}/.exec(command.slice(i + 1));
    if (hex) {
      text += String.fromCharCode(Number.parseInt(hex[0], 16));
      i += 1 + hex[0].length;
    } else if (octal) {
      text += String.fromCharCode(Number.parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
    } else text += c; // an unknown escape keeps its backslash; the next character follows
  }
  return undefined;
}

/**
 * Reads the expansion that starts at `command[at] === "$"`, or undefined for one that is not
 * understood. Only HOME has a value known before anything runs; `$?`, `$#`, `$$` and PIPESTATUS
 * entries vary (and an out-of-range array element is empty), so they are unknown.
 */
function expansion(command: string, at: number, quoted = false): Expansion | undefined {
  const rest = command.slice(at + 1);
  // A `$` that cannot start an expansion is an ordinary character: the end of a regex such as
  // "^\s*$" or "foo$". `$'...'` and `$"..."` are not, so those stay unrecognised.
  const after = rest[0];
  // `$[`, `$=`, `$^` and `$~` are arithmetic or zsh expansions, so they are not in this set.
  const literal = quoted ? /[\s"\\/.:,;)|&<>\]}+%]/ : /[\s/.:,;)|&<>\]}+%]/;
  if (after !== undefined ? literal.test(after) : !quoted)
    return { kind: "text", text: "$", next: at + 1 };
  const home = (): string | undefined => {
    const path = homedir();
    // The text is inserted as-is and never re-parsed, so a backslash (a Windows separator) is
    // harmless; whitespace and glob characters would split or expand when unquoted.
    return /[\s*?[\]'"$`]/.test(path) ? undefined : path;
  };
  if (rest[0] === "(") {
    if (rest[1] === "(") return undefined; // arithmetic expansion
    const end = closingParen(command, at + 2);
    if (end === undefined) return undefined;
    return { kind: "unknown", next: end + 1, inner: command.slice(at + 2, end) };
  }
  if (rest[0] === "'" && !quoted) return ansiString(command, at);
  let name: string | undefined;
  let op: ParamOp | undefined;
  let next: number;
  if (rest[0] === "{") {
    const close = rest.indexOf("}");
    if (close <= 0) return undefined;
    const body = rest.slice(1, close);
    next = at + close + 2;
    if (UNKNOWN_PARAMETER.test(body)) return { kind: "unknown", next };
    const parsed = parameter(body);
    if (!parsed) return undefined;
    ({ name, op } = parsed);
  } else if (rest[0] && "?#$0".includes(rest[0])) {
    return { kind: "unknown", next: at + 2 };
  } else if (rest[0] && /[1-9@*]/.test(rest[0])) {
    name = rest[0];
    next = at + 2;
  } else {
    name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
    if (!name) return undefined;
    next = at + 1 + name.length;
  }
  if (UNKNOWN_PARAMETER.test(name)) return { kind: "unknown", next };
  if (name === "HOME") {
    const text = home();
    return text === undefined ? undefined : { kind: "text", text: applyParamOp(text, op), next };
  }
  return op ? { kind: "var", name, next, op } : { kind: "var", name, next };
}

// --- tokenizer --------------------------------------------------------------------------------

type Token =
  | { t: "word"; w: Word }
  | { t: "op"; op: ";" | ";;" | "\n" | "&&" | "||" | "|" | "&" | "(" | ")" }
  | { t: "redir"; redir: Redir };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const pendingHere: Array<{ redir: Redir; delimiter: string; strip: boolean; quoted: boolean }> =
    [];
  let parts: Part[] = [];
  let lit = "";
  let subs: string[] = [];
  let active = false;
  let quotedAny = false;
  let headPlain = true;
  let assignName: string | undefined;
  let braceOpen = false;
  let braceExpansion = false;
  let globChar = false;
  let quote = "";
  let pendingRedirect: { fd: string; op: Redir["op"] } | undefined;

  const flush = () => {
    if (lit) {
      parts.push(lit);
      lit = "";
    }
  };
  const noAssign = () => {
    if (assignName === undefined) headPlain = false;
  };
  const endWord = () => {
    if (!active) return;
    flush();
    // `{a,b}` and `{1..3}` expand to several words; `{}`, `@{u}` and a lone `{` are literal.
    if (braceExpansion) reject();
    const word: Word = { parts, subs, quoted: quotedAny, assign: assignName, glob: globChar };
    parts = [];
    subs = [];
    active = false;
    quotedAny = false;
    headPlain = true;
    assignName = undefined;
    braceOpen = false;
    braceExpansion = false;
    globChar = false;
    if (pendingRedirect) {
      tokens.push({ t: "redir", redir: { ...pendingRedirect, target: word } });
      pendingRedirect = undefined;
    } else tokens.push({ t: "word", w: word });
  };
  const operator = (op: Extract<Token, { t: "op" }>["op"]) => {
    endWord();
    if (pendingRedirect) reject();
    tokens.push({ t: "op", op });
  };
  const appendUnknown = (quoted: boolean, inner?: string) => {
    flush();
    parts.push(inner === undefined ? { unknown: true, quoted } : { unknown: true, quoted, inner });
    if (inner !== undefined) subs.push(inner);
  };
  const appendExpansion = (e: Expansion, quoted: boolean) => {
    if (e.kind === "text") {
      lit += e.text;
      if (e.quoted) quotedAny = true;
    } else if (e.kind === "var") {
      flush();
      parts.push(e.op ? { name: e.name, quoted, op: e.op } : { name: e.name, quoted });
    } else appendUnknown(quoted, e.inner);
  };

  for (let i = 0; i < src.length; i++) {
    const char = src[i] as string;
    if (quote) {
      if (char === "\n" && pendingHere.length) reject(); // a heredoc body cannot start mid-quote
      if (quote === '"') {
        if (char === "\\") {
          // Inside double quotes a backslash only escapes `"`, `\`, `$` and a backtick; before any
          // other character it is literal. Either way nothing is expanded or executed.
          const next = src[i + 1];
          if (next === undefined) reject();
          if (next === "\n") {
            i++; // a backslash-newline is a line continuation: both characters vanish
            continue;
          }
          if ('"\\$`'.includes(next as string)) {
            lit += next;
            i++;
          } else lit += char;
          continue;
        }
        if (char === "$") {
          const e = expansion(src, i, true);
          if (!e) reject();
          appendExpansion(e as Expansion, true);
          i = (e as Expansion).next - 1;
          continue;
        }
        if (char === "`") {
          const end = closingBacktick(src, i + 1);
          if (end === undefined) reject();
          appendUnknown(true, backtickBody(src.slice(i + 1, end as number)));
          i = end as number;
          continue;
        }
      }
      if (char === quote) quote = "";
      else lit += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      quotedAny = true;
      noAssign();
      continue;
    }
    if (char === "\\") {
      // An unquoted backslash makes the next character literal (`\.`, `\|`, `\ `).
      const next = src[i + 1];
      if (next === undefined) reject();
      if (next === "\n") {
        i++; // line continuation
        continue;
      }
      lit += next;
      active = true;
      quotedAny = true;
      noAssign();
      i++;
      continue;
    }
    if (char === "$") {
      const e = expansion(src, i);
      if (!e) reject();
      noAssign();
      active = true;
      appendExpansion(e as Expansion, false);
      i = (e as Expansion).next - 1;
      continue;
    }
    if (char === "`") {
      const end = closingBacktick(src, i + 1);
      if (end === undefined) reject();
      noAssign();
      active = true;
      appendUnknown(false, backtickBody(src.slice(i + 1, end as number)));
      i = end as number;
      continue;
    }
    if (char === "#" && !active) {
      // A comment runs to the end of the line; `#` inside a word is an ordinary character.
      while (i + 1 < src.length && src[i + 1] !== "\n") i++;
      continue;
    }
    // History expansion is off in the non-interactive shells that run these commands, but `!(`
    // is an extended glob and `!!`/`!$` are worth no risk; `!=` is a comparison operator.
    if (
      char === "!" &&
      !(active === false && (src[i + 1] === undefined || /\s/.test(src[i + 1] as string))) &&
      src[i + 1] !== "="
    ) {
      reject();
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (char === "\n") {
      operator("\n");
      if (pendingHere.length) {
        let at = i + 1;
        for (const h of pendingHere.splice(0)) {
          const body = heredocBody(src, at, h.delimiter, h.strip);
          if (!body) reject();
          const text = (body as { body: string }).body;
          // An unquoted delimiter means the body expands; only a body with nothing to expand is
          // modelled.
          if (!h.quoted && /[$`\\]/.test(text)) reject();
          h.redir.body = text;
          at = (body as { next: number }).next;
        }
        i = at - 1;
      }
      continue;
    }
    if (char === ";") {
      if (src[i + 1] === ";") {
        operator(";;");
        i++;
        if (src[i + 1] === "&") reject();
      } else if (src[i + 1] === "&") reject();
      else operator(";");
      continue;
    }
    if (char === "&") {
      if (src[i + 1] === "&") {
        operator("&&");
        i++;
      } else if (src[i + 1] === ">") {
        endWord();
        if (pendingRedirect) reject();
        const append = src[i + 2] === ">";
        pendingRedirect = { fd: "&", op: append ? ">>" : ">" };
        i += append ? 2 : 1;
      } else operator("&");
      continue;
    }
    if (char === "|") {
      if (src[i + 1] === "|") {
        operator("||");
        i++;
      } else {
        operator("|");
        if (src[i + 1] === "&") i++;
      }
      continue;
    }
    if (char === "(") {
      // `name()` starts a function definition; the parser checks the rest.
      const definition =
        active &&
        src[i + 1] === ")" &&
        parts.length === 0 &&
        !quotedAny &&
        assignName === undefined &&
        NAME.test(lit);
      if ((active && !definition) || src[i + 1] === "(") reject();
      operator("(");
      continue;
    }
    if (char === ")") {
      operator(")");
      continue;
    }
    if ((char === ">" || char === "<") && active && !quotedAny && assignName === undefined) {
      // bash reads `12>file` as a redirection of descriptor 12; zsh reads `12` as a command. Either
      // way the next word is the command, so a multi-digit prefix is not worth modelling.
      if (parts.length === 0 && /^[0-9]{2,}$/.test(lit)) reject();
    }
    if (char === "{") braceOpen = true;
    else if (braceOpen && (char === "," || (char === "." && src[i + 1] === ".")))
      braceExpansion = true;
    if (char === "*" || char === "?" || char === "[") globChar = true;
    if (char === ">" || char === "<") {
      if (src[i + 1] === "(") {
        // Process substitution: a path to a pipe (`/dev/fd/N`) whose command is judged.
        const end = closingParen(src, i + 2);
        if (end === undefined) reject();
        noAssign();
        active = true;
        subs.push(src.slice(i + 2, end as number));
        lit += "/dev/fd/63";
        i = end as number;
        continue;
      }
      if (char === "<" && src[i + 1] === "<" && src[i + 2] === "<") {
        endWord();
        if (pendingRedirect) reject();
        pendingRedirect = { fd: "0", op: "<<<" };
        i += 2;
        continue;
      }
      if (char === "<" && src[i + 1] === "<") {
        const strip = src[i + 2] === "-";
        const read = heredocDelimiter(src, i + (strip ? 3 : 2));
        if (!read) reject();
        const r = read as NonNullable<typeof read>;
        let fd = "0";
        if (
          active &&
          !quotedAny &&
          assignName === undefined &&
          parts.length === 0 &&
          /^[0-9]$/.test(lit)
        ) {
          fd = lit;
          lit = "";
          active = false;
        } else endWord();
        if (pendingRedirect) reject();
        const redir: Redir = { fd, op: "<<" };
        tokens.push({ t: "redir", redir });
        pendingHere.push({ redir, delimiter: r.delimiter, strip, quoted: r.quoted });
        i = r.next - 1;
        continue;
      }
      let fd = char === ">" ? "1" : "0";
      if (
        active &&
        !quotedAny &&
        assignName === undefined &&
        parts.length === 0 &&
        /^[0-9]$/.test(lit)
      ) {
        fd = lit;
        lit = "";
        active = false;
      } else endWord();
      let op: Redir["op"] = char;
      if (char === ">" && src[i + 1] === ">") {
        op = ">>";
        i++;
      } else if (char === ">" && src[i + 1] === "&") {
        op = ">&";
        i++;
      } else if (char === ">" && src[i + 1] === "|") reject();
      else if (char === "<" && (src[i + 1] === "&" || src[i + 1] === ">")) reject();
      if (pendingRedirect) reject();
      pendingRedirect = { fd, op };
      continue;
    }
    if (headPlain && assignName === undefined && parts.length === 0 && char === "=") {
      if (NAME.test(lit)) {
        assignName = lit;
        lit = "";
        headPlain = false;
        active = true;
        continue;
      }
      headPlain = false;
    }
    if (assignName === undefined && !/[A-Za-z0-9_]/.test(char)) headPlain = false;
    // An assignment value starting with `~` or `~/` is the home directory.
    if (
      char === "~" &&
      assignName !== undefined &&
      parts.length === 0 &&
      lit === "" &&
      !quotedAny &&
      (src[i + 1] === undefined || /[/\s;&|)]/.test(src[i + 1] as string))
    ) {
      const path = homedir();
      if (/[\s*?[\]'"$`~]/.test(path)) reject();
      lit += path;
      continue;
    }
    lit += char;
    active = true;
  }
  if (quote || pendingHere.length) reject();
  endWord();
  if (pendingRedirect) reject();
  return tokens;
}

// --- parser -----------------------------------------------------------------------------------

const KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "{",
  "}",
  "function",
  "select",
  "coproc",
  // zsh forms that run the rest of the line or a loop body in the current shell
  "repeat",
  "foreach",
  "always",
]);

function plainWord(w: Word): string | undefined {
  if (w.quoted || w.assign !== undefined || w.parts.length !== 1) return undefined;
  const only = w.parts[0];
  return typeof only === "string" ? only : undefined;
}

/** A `NAME=value` word used as an argument keeps its text. */
function asArgument(w: Word): Word {
  return w.assign === undefined
    ? w
    : { ...w, assign: undefined, parts: [`${w.assign}=`, ...w.parts] };
}

class Parser {
  private pos = 0;
  private nodes = 0;
  constructor(private readonly tokens: Token[]) {}

  parseScript(): ListNode {
    const list = this.list(new Set(), 0);
    if (this.pos < this.tokens.length) reject();
    return list;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private keyword(tok: Token | undefined): string | undefined {
    if (tok?.t !== "word") return undefined;
    const text = plainWord(tok.w);
    return text !== undefined && KEYWORDS.has(text) ? text : undefined;
  }

  private atTerminator(terms: Set<string>): boolean {
    const tok = this.peek();
    if (!tok) return false;
    if (tok.t === "op") return terms.has(tok.op);
    return tok.t === "word" && terms.has(plainWord(tok.w) ?? "\0");
  }

  private expectKeyword(word: string): void {
    const tok = this.peek();
    if (tok?.t !== "word" || plainWord(tok.w) !== word) reject();
    this.pos++;
  }

  private skipNewlines(): void {
    while (this.peek()?.t === "op" && (this.peek() as { op: string }).op === "\n") this.pos++;
  }

  private list(terms: Set<string>, depth: number): ListNode {
    const items: ListNode["items"] = [];
    for (;;) {
      for (;;) {
        const t = this.peek();
        if (t?.t === "op" && (t.op === ";" || t.op === "\n")) this.pos++;
        else break;
      }
      if (this.pos >= this.tokens.length || this.atTerminator(terms)) break;
      const node = this.andOr(depth);
      let background = false;
      const next = this.peek();
      if (next?.t === "op" && next.op === "&") {
        background = true;
        this.pos++;
      } else if (
        next &&
        !this.atTerminator(terms) &&
        !(next.t === "op" && (next.op === ";" || next.op === "\n"))
      )
        reject();
      items.push({ node, background });
    }
    return { items };
  }

  private andOr(depth: number): AndOr {
    const first = this.pipeline(depth);
    const rest: AndOr["rest"] = [];
    for (;;) {
      const t = this.peek();
      if (t?.t !== "op" || (t.op !== "&&" && t.op !== "||")) break;
      this.pos++;
      this.skipNewlines();
      rest.push({ op: t.op, node: this.pipeline(depth) });
    }
    return { first, rest };
  }

  private pipeline(depth: number): PipelineNode {
    let negated = false;
    const first = this.peek();
    if (first?.t === "word" && plainWord(first.w) === "!") {
      negated = true;
      this.pos++;
    }
    const stages: Command[] = [this.command(depth)];
    for (;;) {
      const t = this.peek();
      if (t?.t !== "op" || t.op !== "|") break;
      this.pos++;
      this.skipNewlines();
      stages.push(this.command(depth));
    }
    return { stages, negated };
  }

  private redirects(): Redir[] {
    const out: Redir[] = [];
    for (let t = this.peek(); t?.t === "redir"; t = this.peek()) {
      out.push(t.redir);
      this.pos++;
    }
    return out;
  }

  private command(depth: number): Command {
    if (++this.nodes > MAX_NODES) reject();
    const tok = this.peek();
    if (!tok) reject();
    if (tok?.t === "op") {
      if (tok.op !== "(") reject();
      if (depth >= MAX_DEPTH) reject();
      this.pos++;
      const body = this.list(new Set([")"]), depth + 1);
      if (this.peek()?.t !== "op" || (this.peek() as { op: string }).op !== ")") reject();
      this.pos++;
      return { kind: "subshell", body, redirects: this.redirects() };
    }
    const word = this.keyword(tok);
    const open = this.tokens[this.pos + 1];
    const close = this.tokens[this.pos + 2];
    if (
      word === undefined &&
      tok?.t === "word" &&
      open?.t === "op" &&
      open.op === "(" &&
      close?.t === "op" &&
      close.op === ")"
    ) {
      const name = plainWord(tok.w);
      if (name === undefined || !NAME.test(name) || depth >= MAX_DEPTH) reject();
      this.pos += 3;
      this.skipNewlines();
      const body = this.command(depth + 1);
      if ((body.kind !== "group" && body.kind !== "subshell") || body.redirects.length) reject();
      return { kind: "function", name: name as string, body: body as Group | Subshell };
    }
    if (word === undefined) return this.simple();
    if (depth >= MAX_DEPTH) reject();
    this.pos++;
    switch (word) {
      case "{": {
        const body = this.list(new Set(["}"]), depth + 1);
        this.expectKeyword("}");
        return { kind: "group", body, redirects: this.redirects() };
      }
      case "for": {
        const nameTok = this.peek();
        const name = nameTok?.t === "word" ? plainWord(nameTok.w) : undefined;
        if (name === undefined || !NAME.test(name) || KEYWORDS.has(name)) reject();
        this.pos++;
        this.expectKeyword("in");
        const words: Word[] = [];
        for (;;) {
          const t = this.peek();
          if (t?.t !== "word") break;
          words.push(asArgument(t.w));
          this.pos++;
        }
        const sep = this.peek();
        if (sep?.t !== "op" || (sep.op !== ";" && sep.op !== "\n")) reject();
        this.skipSeparators();
        this.expectKeyword("do");
        const body = this.list(new Set(["done"]), depth + 1);
        this.expectKeyword("done");
        return { kind: "for", name: name as string, words, body, redirects: this.redirects() };
      }
      case "while":
      case "until": {
        const cond = this.list(new Set(["do"]), depth + 1);
        this.expectKeyword("do");
        const body = this.list(new Set(["done"]), depth + 1);
        this.expectKeyword("done");
        return {
          kind: "while",
          cond,
          body,
          redirects: this.redirects(),
          ...(word === "until" ? { until: true } : {}),
        };
      }
      case "if": {
        const clauses: IfNode["clauses"] = [];
        let otherwise: ListNode | undefined;
        for (;;) {
          const cond = this.list(new Set(["then"]), depth + 1);
          this.expectKeyword("then");
          const body = this.list(new Set(["elif", "else", "fi"]), depth + 1);
          clauses.push({ cond, body });
          const next = this.peek();
          const kw = next?.t === "word" ? plainWord(next.w) : undefined;
          if (kw === "elif") {
            this.pos++;
            continue;
          }
          if (kw === "else") {
            this.pos++;
            otherwise = this.list(new Set(["fi"]), depth + 1);
          }
          this.expectKeyword("fi");
          break;
        }
        return { kind: "if", clauses, otherwise, redirects: this.redirects() };
      }
      case "case": {
        const subject = this.peek();
        if (subject?.t !== "word") reject();
        this.pos++;
        this.expectKeyword("in");
        const branches: CaseNode["branches"] = [];
        for (;;) {
          this.skipSeparators();
          const t = this.peek();
          if (t?.t === "word" && plainWord(t.w) === "esac") {
            this.pos++;
            break;
          }
          if (t?.t === "op" && t.op === "(") this.pos++;
          const patterns: Word[] = [];
          for (;;) {
            const p = this.peek();
            if (p?.t !== "word") reject();
            patterns.push(asArgument((p as { w: Word }).w));
            this.pos++;
            const sep = this.peek();
            if (sep?.t === "op" && sep.op === "|") {
              this.pos++;
              continue;
            }
            break;
          }
          const close = this.peek();
          if (close?.t !== "op" || close.op !== ")") reject();
          this.pos++;
          const body = this.list(new Set([";;", "esac"]), depth + 1);
          branches.push({ patterns, body });
          const end = this.peek();
          if (end?.t === "op" && end.op === ";;") this.pos++;
        }
        return {
          kind: "case",
          word: asArgument((subject as { w: Word }).w),
          branches,
          redirects: this.redirects(),
        };
      }
      default:
        return reject(); // then, fi, do, done, esac, in, }, function, select, coproc out of place
    }
  }

  private skipSeparators(): void {
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.op === ";" || t.op === "\n")) this.pos++;
      else break;
    }
  }

  private simple(): Simple {
    const assigns: Simple["assigns"] = [];
    const argv: Word[] = [];
    const redirects: Redir[] = [];
    for (let t = this.peek(); t; t = this.peek()) {
      if (t.t === "op") break;
      if (t.t === "redir") redirects.push(t.redir);
      else if (argv.length === 0 && t.w.assign !== undefined)
        assigns.push({ name: t.w.assign, value: t.w });
      else {
        // A program name never contains `=`; a leading word that does is an assignment this
        // parser cannot represent (`FOO+=x`, `FOO[0]=x`, quoted or escaped names).
        if (argv.length === 0 && t.w.parts.some((p) => typeof p === "string" && p.includes("=")))
          reject();
        argv.push(asArgument(t.w));
      }
      this.pos++;
    }
    const after = this.peek();
    if (after?.t === "op" && after.op === "(") reject();
    if (!assigns.length && !argv.length && !redirects.length) reject();
    // zsh also recognises a reserved word after leading assignments or redirections, so a command
    // named like one is not a plain command here.
    const head = argv[0] ? plainWord(argv[0]) : undefined;
    if (head !== undefined && KEYWORDS.has(head)) reject();
    return { kind: "simple", assigns, argv, redirects };
  }
}

export function parseScript(command: string): ListNode | undefined {
  if (
    !command ||
    command.length > MAX_INPUT ||
    command.includes("\0") ||
    command.includes("\r") ||
    command.includes(SUBSTITUTION)
  )
    return undefined;
  try {
    const script = new Parser(tokenize(command)).parseScript();
    return script.items.length ? script : undefined;
  } catch (error) {
    if (error instanceof Reject) return undefined;
    throw error;
  }
}
