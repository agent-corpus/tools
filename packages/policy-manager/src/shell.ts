// Parses a bounded subset of POSIX shell: simple commands joined by `;`, newlines, `&&`, `||`
// and `|`, with quoting, leading VAR=value assignments and file redirections. Anything whose
// effects depend on expansion (`$`, backticks, subshells, braces, heredocs, background jobs,
// backslashes, comments, process substitution) is rejected so a caller can fall back to a human.

export interface Redirect {
  fd: string;
  op: ">" | ">>" | "<" | ">&";
  target: string;
}
export interface SimpleCommand {
  env: Array<[string, string]>;
  argv: string[];
  redirects: Redirect[];
}
export type Pipeline = SimpleCommand[];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseShell(command: string): Pipeline[] | undefined {
  if (!command || command.includes("\0") || command.includes("\r")) return undefined;
  const pipelines: Pipeline[] = [];
  let pipeline: Pipeline = [];
  let words: Array<{ text: string; quoted: boolean }> = [];
  let redirects: Redirect[] = [];
  let pendingRedirect: { fd: string; op: Redirect["op"] } | undefined;
  let current = "";
  let active = false;
  let quoted = false;
  let quote = "";
  let dangling = false;

  const endWord = (): boolean => {
    if (!active) return true;
    const word = { text: current, quoted };
    current = "";
    active = false;
    quoted = false;
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
      if (!word || word.quoted || !ASSIGNMENT.test(word.text)) break;
      const eq = word.text.indexOf("=");
      env.push([word.text.slice(0, eq), word.text.slice(eq + 1)]);
      index++;
    }
    const argv = words.slice(index).map((word) => word.text);
    if (!argv.length) return false;
    pipeline.push({ env, argv, redirects });
    words = [];
    redirects = [];
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
      if (quote === '"' && /[$`\\]/.test(char)) return undefined;
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      quoted = true;
      continue;
    }
    if (/[`$(){}\\#!]/.test(char)) {
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
    current += char;
    active = true;
  }
  if (quote) return undefined;
  endWord();
  if (dangling || !endPipeline(true)) return undefined;
  return pipelines.length ? pipelines : undefined;
}
