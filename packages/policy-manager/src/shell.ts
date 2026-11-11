// Parses a bounded subset of POSIX shell: simple commands joined by `;`, newlines, `&&`, `||`
// and `|`, with quoting, leading VAR=value assignments and file redirections. Anything whose
// effects depend on expansion is rejected so a caller can fall back to a human. Two kinds of
// expansion are understood: parameters whose value is known without running anything (`$?`, `$#`,
// `$$`, `$HOME`, `PIPESTATUS`), which are substituted, and command substitution (`$(...)` and
// backticks), whose inner command is returned in `subs` for the caller to judge and whose output
// is represented in a word by SUBSTITUTION. Everything else (other variables, arithmetic, braces,
// subshells, heredocs, background jobs, comments, process substitution) is rejected.

import { homedir } from "node:os";

/** Stands for the unknown output of a command substitution inside a word. */
export const SUBSTITUTION = "\uE000";

export interface Redirect {
  fd: string;
  op: ">" | ">>" | "<" | ">&";
  target: string;
}
export interface SimpleCommand {
  env: Array<[string, string]>;
  argv: string[];
  redirects: Redirect[];
  /** Inner commands of `$(...)` and backticks in this command's words, in order. */
  subs: string[];
}
export type Pipeline = SimpleCommand[];

const ASSIGNMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Index of the `)` that closes a `$(` whose body starts at `start`, honouring quotes and nesting. */
function closingParen(command: string, start: number): number | undefined {
  let depth = 1;
  let j = start;
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
    } else {
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
      j++;
    }
  }
  return undefined;
}

function closingBacktick(command: string, start: number): number | undefined {
  for (let j = start; j < command.length; j++) {
    if (command[j] === "\\") j++;
    else if (command[j] === "`") return j;
  }
  return undefined;
}

const KNOWN_PARAMETER = /^(?:HOME|(?:PIPESTATUS|pipestatus)(?:\[[0-9@*]+\])?)$/;

/**
 * Reads the expansion that starts at `command[at] === "$"`. Returns the text it stands for and the
 * index after it, any command substitution body, or undefined for an expansion that is not
 * understood.
 */
function expansion(
  command: string,
  at: number,
): { text: string; next: number; inner?: string } | undefined {
  const rest = command.slice(at + 1);
  const known = (name: string): string | undefined => {
    if (name === "HOME") {
      const home = homedir();
      return /[\s*?[\]'"\\$`]/.test(home) ? undefined : home;
    }
    return "0"; // an exit status or PIPESTATUS entry: digits only
  };
  if (rest[0] === "(") {
    if (rest[1] === "(") return undefined; // arithmetic expansion
    const end = closingParen(command, at + 2);
    if (end === undefined) return undefined;
    return { text: SUBSTITUTION, next: end + 1, inner: command.slice(at + 2, end) };
  }
  if (rest[0] === "{") {
    const close = rest.indexOf("}");
    const name = close > 0 ? rest.slice(1, close) : "";
    if (!KNOWN_PARAMETER.test(name)) return undefined;
    const text = known(name.startsWith("HOME") ? "HOME" : name);
    return text === undefined ? undefined : { text, next: at + close + 2 };
  }
  if (rest[0] && "?#$".includes(rest[0])) return { text: "0", next: at + 2 };
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
  if (name && KNOWN_PARAMETER.test(name)) {
    const text = known(name);
    return text === undefined ? undefined : { text, next: at + 1 + name.length };
  }
  return undefined;
}

/** Body of a backtick substitution: backslash escapes `\``, `\\` and `\$` are removed first. */
function backtickBody(raw: string): string {
  return raw.replace(/\\([`\\$])/g, "$1");
}

export function parseShell(command: string): Pipeline[] | undefined {
  if (
    !command ||
    command.includes("\0") ||
    command.includes("\r") ||
    command.includes(SUBSTITUTION)
  )
    return undefined;
  const pipelines: Pipeline[] = [];
  let pipeline: Pipeline = [];
  let words: Array<{ text: string; assignAt: number }> = [];
  let redirects: Redirect[] = [];
  let subs: string[] = [];
  let pendingRedirect: { fd: string; op: Redirect["op"] } | undefined;
  let current = "";
  let active = false;
  let quoted = false;
  // A word is an assignment only if its `NAME=` prefix was typed plainly. Quotes or escapes later,
  // in the value, are fine (`FOO="a b" cmd`); a quote or escape before the `=` is not an assignment.
  let plain = true;
  let eqAt = -1;
  let quote = "";
  let dangling = false;

  const endWord = (): boolean => {
    if (!active) return true;
    const word = { text: current, assignAt: plain ? eqAt : -1 };
    current = "";
    active = false;
    quoted = false;
    plain = true;
    eqAt = -1;
    if (pendingRedirect) {
      redirects.push({ ...pendingRedirect, target: word.text });
      pendingRedirect = undefined;
    } else {
      words.push(word);
      dangling = false;
    }
    return true;
  };
  const endSimple = (): boolean => {
    if (pendingRedirect) return false;
    if (!words.length && !redirects.length) return true;
    const env: Array<[string, string]> = [];
    let index = 0;
    while (index < words.length) {
      const word = words[index];
      if (!word || word.assignAt < 1 || !ASSIGNMENT_NAME.test(word.text.slice(0, word.assignAt)))
        break;
      env.push([word.text.slice(0, word.assignAt), word.text.slice(word.assignAt + 1)]);
      index++;
    }
    const argv = words.slice(index).map((word) => word.text);
    if (!argv.length) return false;
    // Bash also treats `FOO+=x`, `FOO[0]=x` and quoted or escaped forms as assignments and then runs
    // the next word. A program name never contains `=`, so a leading word that still has one is
    // an assignment this parser cannot represent: reject it instead of judging it as the program.
    if (argv[0]?.includes("=")) return false;
    pipeline.push({ env, argv, redirects, subs });
    words = [];
    redirects = [];
    subs = [];
    return true;
  };
  const endPipeline = (allowEmpty: boolean): boolean => {
    if (!endSimple()) return false;
    if (!pipeline.length) return allowEmpty;
    pipelines.push(pipeline);
    pipeline = [];
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote) {
      if (quote === '"') {
        if (char === "\\") {
          // Inside double quotes a backslash only escapes `"`, `\`, `$` and a backtick; before any
          // other character it is literal. Either way nothing is expanded or executed.
          const next = command[i + 1];
          if (next === undefined || next === "\n") return undefined;
          if ('"\\$`'.includes(next)) {
            current += next;
            i++;
          } else current += char;
          continue;
        }
        if (char === "$") {
          const expanded = expansion(command, i);
          if (!expanded) return undefined;
          current += expanded.text;
          if (expanded.inner !== undefined) subs.push(expanded.inner);
          i = expanded.next - 1;
          continue;
        }
        if (char === "`") {
          const end = closingBacktick(command, i + 1);
          if (end === undefined) return undefined;
          subs.push(backtickBody(command.slice(i + 1, end)));
          current += SUBSTITUTION;
          i = end;
          continue;
        }
      }
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      quoted = true;
      if (eqAt < 0) plain = false;
      continue;
    }
    if (char === "\\") {
      // An unquoted backslash makes the next character literal (`\.`, `\|`, `\ `).
      const next = command[i + 1];
      if (next === undefined || next === "\n") return undefined;
      current += next;
      active = true;
      quoted = true;
      if (eqAt < 0) plain = false;
      i++;
      continue;
    }
    if (char === "$") {
      const expanded = expansion(command, i);
      if (!expanded) return undefined;
      if (eqAt < 0) plain = false;
      current += expanded.text;
      active = true;
      if (expanded.inner !== undefined) subs.push(expanded.inner);
      i = expanded.next - 1;
      continue;
    }
    if (char === "`") {
      const end = closingBacktick(command, i + 1);
      if (end === undefined) return undefined;
      if (eqAt < 0) plain = false;
      subs.push(backtickBody(command.slice(i + 1, end)));
      current += SUBSTITUTION;
      active = true;
      i = end;
      continue;
    }
    if (/[(){}#!]/.test(char)) {
      // `#` only starts a comment at a word boundary, but rejecting it everywhere is simpler.
      return undefined;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (char === "\n" || char === ";") {
      endWord();
      if (dangling || !endPipeline(true)) return undefined;
      continue;
    }
    if (char === "&") {
      if (command[i + 1] !== "&") return undefined;
      endWord();
      if (!endPipeline(false)) return undefined;
      dangling = true;
      i++;
      continue;
    }
    if (char === "|") {
      endWord();
      if (command[i + 1] === "|") {
        if (!endPipeline(false)) return undefined;
        i++;
      } else if (!words.length || !endSimple()) return undefined;
      dangling = true;
      continue;
    }
    if (char === ">" || char === "<") {
      if (command[i + 1] === "(" || (char === "<" && command[i + 1] === "<")) return undefined;
      let fd = char === ">" ? "1" : "0";
      if (active && !quoted && /^[0-9]$/.test(current)) {
        fd = current;
        current = "";
        active = false;
      } else endWord();
      let op: Redirect["op"] = char;
      if (char === ">" && command[i + 1] === ">") {
        op = ">>";
        i++;
      } else if (char === ">" && command[i + 1] === "&") {
        op = ">&";
        i++;
      } else if (char === ">" && command[i + 1] === "|") return undefined;
      if (pendingRedirect) return undefined;
      pendingRedirect = { fd, op };
      continue;
    }
    if (plain && eqAt < 0 && char === "=") eqAt = current.length;
    current += char;
    active = true;
  }
  if (quote) return undefined;
  endWord();
  if (dangling || !endPipeline(true)) return undefined;
  return pipelines.length ? pipelines : undefined;
}
