import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { canonical, resolveWord, tempRoots } from "./evidence.js";

/**
 * Whether a write, move or delete target could reach the policy service's own state: the
 * `acp-<uid>-*` session directories in the temp directory (audit logs, token, socket, grants,
 * cache). Targets are matched as the shell would expand them, against the real directories and a
 * sample one, so a glob (`acp-*`, `a*p-501*`, `[a]cp-*`), an unknown expansion (read as `*`) or a
 * directory above the state (`rm -rf $TMPDIR`) counts, not only the literal name.
 */

const slashes = (path: string) => path.replace(/\\/g, "/");
const WINDOWS = process.platform === "win32";
const STATE_DIR = /^acp-(?:\d+|user)-/i;
/** Files a session directory holds, by name; a sample stands for the rotated logs. */
const STATE_FILES = ["audit.jsonl", "audit.00000001.jsonl", "token", "service.sock", "grants.json"];

/**
 * Longest word or pattern matched here. Anything longer fails closed (counts as reaching the
 * state), so no input can make matching slow.
 */
export const MAX_TARGET = 4096;

/** `text` without trailing `/` (a loop, linear on any input). */
function stripSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end--;
  return text.slice(0, end);
}

/** `path` without a trailing separator (the root stays `/`). */
function trim(path: string): string {
  const trimmed = stripSlashes(path);
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Whether `pattern` has a brace expansion: a `{...}` with no nested braces and a `,` or `..`
 * inside. One pass, linear.
 */
function hasBrace(pattern: string): boolean {
  let open = -1;
  let separated = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (c === "{") {
      open = i;
      separated = false;
    } else if (open >= 0 && (c === "," || (c === "." && pattern[i + 1] === "."))) separated = true;
    else if (c === "}") {
      if (open >= 0 && separated) return true;
      open = -1;
    }
  }
  return false;
}

let cache: { at: number; temp: string; dirs: string[] } | undefined;
/**
 * The state directories: every `acp-<uid>-*` directory in each temp root, plus a sample one in the
 * temp directory the service uses, so a pattern that would match a later session's directory
 * counts too. Each is listed under both the temp directory as the system gives it (on macOS the
 * logical `/var/folders/...`, where the service creates them) and its real path
 * (`/private/var/folders/...`), so a pattern written against either form matches.
 */
export function stateDirs(): string[] {
  const temp = `${process.env.TMPDIR}|${process.env.TMP}|${process.env.TEMP}`;
  if (cache && cache.temp === temp && Date.now() - cache.at < 2000) return cache.dirs;
  const uid = String(process.getuid?.() ?? "user");
  const sample = `acp-${uid}-0123456789abcdef01234567`;
  const logical = trim(slashes(tmpdir()));
  let real = logical;
  try {
    real = trim(slashes(canonical(tmpdir())));
  } catch {
    /* judged as given */
  }
  const dirs = new Set<string>([`${logical}/${sample}`, `${real}/${sample}`]);
  for (const root of tempRoots()) {
    const base = trim(slashes(root));
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue; // unreadable: the samples still count
    }
    for (const name of names) {
      if (!STATE_DIR.test(name)) continue;
      dirs.add(`${base}/${name}`);
      // The same directory under the other form of the temp directory.
      if (base === real && logical !== real) dirs.add(`${logical}/${name}`);
      if (base === logical && logical !== real) dirs.add(`${real}/${name}`);
    }
  }
  cache = { at: Date.now(), temp, dirs: [...dirs] };
  return cache.dirs;
}

const fold = (path: string) => (WINDOWS ? path.toLowerCase() : path);
let lists:
  | {
      from: string[];
      dirs: string[];
      above: string[];
      real: Map<string, string | null>;
      names: Map<string, boolean>;
      dirSet: Set<string>;
      aboveSet: Set<string>;
    }
  | undefined;
/**
 * The state directories and the directories above them, folded for comparison, with a cache of
 * real paths. Rebuilt whenever `stateDirs` is (every 2 seconds at most), so a long-running service
 * never judges with stale filesystem facts for longer than that.
 */
function stateLists(): NonNullable<typeof lists> {
  const from = stateDirs();
  if (lists?.from !== from)
    lists = {
      from,
      dirs: from.map(fold),
      above: stateAncestors().map(fold),
      real: new Map(),
      names: new Map(),
      dirSet: new Set(from.map(fold)),
      aboveSet: new Set(stateAncestors().map(fold)),
    };
  return lists;
}
/**
 * The real path of `path` as `/` text, or undefined: its directory's real path (memoized for the
 * current state lists, so words in one directory cost one lookup) and its own name. A symlink as
 * the last name is not followed: making one that points at the state names the state, which the
 * rule already catches.
 */
function realOf(path: string): string | undefined {
  const parent = dirname(path);
  if (parent === path) return trim(path);
  const base = realDir(parent);
  return base === undefined ? undefined : `${base === "/" ? "" : base}/${basename(path)}`;
}
function realDir(dir: string): string | undefined {
  const cache = stateLists().real;
  const known = cache.get(dir);
  if (known !== undefined) return known ?? undefined;
  let real: string | null = null;
  try {
    real = trim(slashes(canonical(dir)));
  } catch {
    /* judged as written */
  }
  if (cache.size < 10_000) cache.set(dir, real);
  return real ?? undefined;
}

/** Every directory a state directory lies in, from the filesystem root down. */
function stateAncestors(): string[] {
  const found = new Set<string>();
  for (const dir of stateDirs()) {
    const parts = dir.split("/");
    for (let i = 1; i < parts.length; i++) found.add(trim(parts.slice(0, i).join("/") || "/"));
  }
  return [...found];
}

type Token =
  | { kind: "star" }
  | { kind: "one" }
  | { kind: "set"; negate: boolean; items: Array<[string, string]> }
  | { kind: "char"; c: string };

/**
 * A shell glob as tokens: `*`, `?`, `[...]` with `!`/`^` negation and ranges, and `\` escapes.
 * Undefined for a brace expansion (`{a,b}`, `{1..3}`), which callers treat as matching.
 */
const tokenCache = new Map<string, Token[] | undefined>();
/** `tokenize`, memoized (a script names the same patterns many times). */
function tokenize(pattern: string): Token[] | undefined {
  if (tokenCache.has(pattern)) return tokenCache.get(pattern);
  const tokens = tokenizeOnce(pattern);
  if (tokenCache.size > 4096) tokenCache.clear();
  tokenCache.set(pattern, tokens);
  return tokens;
}
function tokenizeOnce(pattern: string): Token[] | undefined {
  if (pattern.length > MAX_TARGET || hasBrace(pattern)) return undefined;
  const out: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "\\" && i + 1 < pattern.length) out.push({ kind: "char", c: pattern[++i] as string });
    else if (c === "*") {
      if (out[out.length - 1]?.kind !== "star") out.push({ kind: "star" });
    } else if (c === "?") out.push({ kind: "one" });
    else if (c === "[") {
      let j = i + 1;
      const negate = pattern[j] === "!" || pattern[j] === "^";
      if (negate) j++;
      const items: Array<[string, string]> = [];
      let first = true;
      while (j < pattern.length && (pattern[j] !== "]" || first)) {
        const lo = pattern[j] as string;
        if (pattern[j + 1] === "-" && pattern[j + 2] !== undefined && pattern[j + 2] !== "]") {
          items.push([lo, pattern[j + 2] as string]);
          j += 3;
        } else {
          items.push([lo, lo]);
          j++;
        }
        first = false;
      }
      if (j >= pattern.length) out.push({ kind: "char", c });
      else {
        out.push({ kind: "set", negate, items });
        i = j;
      }
    } else out.push({ kind: "char", c });
  }
  return out;
}

/** Whether a shell glob matches `text`. `*` matches any run, `/` included (as `find -path` does). */
export function globMatch(pattern: string, text: string, fold = WINDOWS): boolean {
  const p = fold ? pattern.toLowerCase() : pattern;
  const t = fold ? text.toLowerCase() : text;
  const tokens = tokenize(p);
  if (!tokens) return true;
  const one = (token: Token, c: string) =>
    token.kind === "one" ||
    (token.kind === "char" && token.c === c) ||
    (token.kind === "set" && token.items.some(([lo, hi]) => c >= lo && c <= hi) !== token.negate);
  let k = 0,
    i = 0,
    star = -1,
    mark = 0;
  while (i < t.length) {
    const token = tokens[k];
    if (token && token.kind !== "star" && one(token, t[i] as string)) {
      k++;
      i++;
    } else if (token?.kind === "star") {
      star = k++;
      mark = i;
    } else if (star >= 0) {
      k = star + 1;
      i = ++mark;
    } else return false;
  }
  while (tokens[k]?.kind === "star") k++;
  return k === tokens.length;
}

export const hasGlob = (text: string) => /[*?[]/.test(text) || tokenize(text) === undefined;

/**
 * Whether path `pattern` names `target`, segment by segment, or (with `inside`) anything within
 * it. A `**` segment matches any number of segments; a pattern this cannot follow matches.
 */
function pathMatch(pattern: string, target: string, inside: boolean): boolean {
  const ps = trim(pattern).split("/");
  const ts = trim(target).split("/");
  // Memoized on (pattern segment, target segment), so any number of `**` stays polynomial.
  const seen = new Set<number>();
  const go = (a: number, b: number): boolean => {
    if (b === ts.length) return a === ps.length || (inside && a > 0) || ps[a] === "**";
    if (a === ps.length) return false;
    const key = a * (ts.length + 1) + b;
    if (seen.has(key)) return false;
    seen.add(key);
    if (ps[a] === "**") return go(a + 1, b) || go(a, b + 1);
    return globMatch(ps[a] as string, ts[b] as string) && go(a + 1, b + 1);
  };
  return go(0, 0);
}

/** A shell word's text with the temp variables filled in and any other expansion read as `*`. */
export function stateText(text: string, literal: boolean): string {
  if (literal) return text;
  if (text.length > MAX_TARGET) return "*";
  const temp = slashes(tmpdir());
  // One pass: `$NAME`, `${...}`, `$(...)` and backticks; the temp variables become the temp
  // directory and anything else `*`. An unclosed one runs to the end.
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      out += "*";
      i = end < 0 ? text.length : end;
    } else if (c !== "$") out += c;
    else if (text[i + 1] === "{" || text[i + 1] === "(") {
      const close = text[i + 1] === "{" ? "}" : ")";
      const end = text.indexOf(close, i + 2);
      const name = end < 0 ? "" : text.slice(i + 2, end);
      out += /^(?:TMPDIR|TMP|TEMP)$/.test(name) && close === "}" ? temp : "*";
      i = end < 0 ? text.length : end;
    } else {
      let j = i + 1;
      while (j < text.length && /\w/.test(text[j] as string)) j++;
      const name = text.slice(i + 1, j);
      out += /^(?:TMPDIR|TMP|TEMP)$/.test(name) ? temp : "*";
      i = j > i + 1 ? j - 1 : i + (/[@*#?$!-]/.test(text[i + 1] ?? "") ? 1 : 0);
    }
  }
  return out;
}

/**
 * Whether a target word (as `stateText` gives it) could name the policy service's state from any
 * of `cwds`: a state directory, a file in one, anything inside one, or, for a delete or move
 * (`removes`), a directory the state lies in (`rm -rf $TMPDIR`, `rm -rf /tmp/*`).
 */
export function namesState(text: string, cwds: Iterable<string>, removes: boolean): boolean {
  if (!text) return false;
  if (text.length > MAX_TARGET) return true;
  // An option or a number names no file.
  if (/^-[^=]*$|^\d+$/.test(text)) return false;
  // The same word in the same directories is asked many times: memoized with the state lists.
  const list = [...cwds];
  const memo = stateLists().names;
  const key = `${removes ? 1 : 0}\0${text}\0${list.join("\0")}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const answer = namesStateOnce(text, list, removes);
  if (memo.size < 20_000) memo.set(key, answer);
  return answer;
}
function namesStateOnce(text: string, cwds: string[], removes: boolean): boolean {
  const { dirs, above: ancestors } = stateLists();
  const above = removes ? ancestors : [];
  const forms = new Set<string>();
  for (const cwd of cwds) {
    let path: string;
    try {
      path = slashes(resolveWord(cwd, text));
    } catch {
      continue;
    }
    forms.add(trim(path));
    const real = realOf(path);
    if (real !== undefined) forms.add(real);
  }
  for (const raw of forms) {
    const form = fold(raw);
    if (!hasGlob(form)) {
      // A literal path: a state directory, anything in one, or (for a delete) a directory above.
      // Set lookups on each prefix: linear in the path, whatever the number of state directories.
      const { dirSet, aboveSet } = stateLists();
      for (let at = form.indexOf("/", 1); ; at = form.indexOf("/", at + 1)) {
        if (dirSet.has(at < 0 ? form : form.slice(0, at))) return true;
        if (at < 0) break;
      }
      if (removes && aboveSet.has(form)) return true;
      continue;
    }
    // A glob: only directories its literal start leads to can match.
    const lead = form.slice(0, form.search(/[*?[{]/));
    const base = lead.slice(0, lead.lastIndexOf("/") + 1);
    const near = (dir: string) => dir.startsWith(base) || `${dir}/`.startsWith(base);
    if (dirs.some((dir) => near(dir) && pathMatch(form, dir, true))) return true;
    if (above.some((dir) => near(dir) && pathMatch(form, dir, false))) return true;
  }
  return false;
}

/**
 * Whether `find` with an action that deletes or runs something could reach the state: a start
 * directory in or above a state directory, and a `-name`/`-iname` pattern that can match a name on
 * the way down, a `-path`/`-ipath` pattern that can match the path find prints, a `-regex`
 * (not followed: fails closed), or no such filter at all.
 */
export function findReachesState(args: string[], cwds: Iterable<string>): boolean {
  const start = args.findIndex((arg) => /^[-!(]/.test(arg));
  const roots = args.slice(0, start < 0 ? args.length : start);
  const names: Array<[string, boolean]> = [];
  const paths: Array<[string, boolean]> = [];
  let regex = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = args[i + 1] ?? "";
    if (arg === "-name" || arg === "-iname") names.push([value, arg === "-iname"]);
    else if (arg === "-path" || arg === "-ipath" || arg === "-wholename" || arg === "-iwholename")
      paths.push([value, arg.startsWith("-i")]);
    else if (arg === "-regex" || arg === "-iregex") regex = true;
  }
  const targets = stateDirs().flatMap((dir) => [
    dir,
    ...STATE_FILES.map((file) => `${dir}/${file}`),
  ]);
  for (const rootText of roots.length ? roots : ["."]) {
    for (const cwd of cwds) {
      let root: string;
      try {
        root = trim(slashes(canonical(resolveWord(cwd, rootText))));
      } catch {
        try {
          root = trim(slashes(resolveWord(cwd, rootText)));
        } catch {
          return true;
        }
      }
      if (hasGlob(rootText)) {
        if (namesState(rootText, [cwd], true)) return true;
        continue;
      }
      const prefix = root === "/" ? "/" : `${root}/`;
      for (const target of targets) {
        if (target !== root && !target.startsWith(prefix)) continue;
        // Inside a state directory, every entry is state.
        if (
          target !== root &&
          stateDirs().some((dir) => root.startsWith(`${dir}/`) || root === dir)
        )
          return true;
        if (regex || (!names.length && !paths.length)) return true;
        const rel = target === root ? "" : target.slice(prefix.length);
        const steps = rel.split("/").filter(Boolean);
        if (names.some(([pattern, fold]) => steps.some((step) => globMatch(pattern, step, fold))))
          return true;
        const printed = `${stripSlashes(rootText)}/${rel}`;
        if (paths.some(([pattern, fold]) => globMatch(pattern, printed, fold))) return true;
      }
    }
  }
  return false;
}

/** The temp directory computed at run time (case matters: `/tmp` in a path is not `TMP`). */
const TEMP_LOOKUP =
  /\$\{?(?:TMPDIR|TMP|TEMP)\b|environ\b[^\n]{0,40}\b(?:TMPDIR|TMP|TEMP)\b|process\.env\.(?:TMPDIR|TMP|TEMP)\b|ENV\[\s*["'](?:TMPDIR|TMP|TEMP)|getenv\(\s*["'](?:TMPDIR|TMP|TEMP)|gettempdir|tempfile\.tempdir|os\.tmpdir|tmpdir\(\)|Dir\.tmpdir|sys_get_temp_dir|GetTempPath/;

/** Longest inline code judged; longer code fails closed. */
const MAX_CODE = 100_000;

/** File calls that take two paths (source and destination); every other one takes one. */
const TWO_PATHS = new Set([
  ...["rename", "renames", "replace", "move", "copy", "copyfile", "copy2", "copytree", "mv"],
  ...["cp", "renameSync", "copyFileSync", "cpSync", "copyFile", "symlink", "link", "symlinkSync"],
  ...["linkSync", "cp_r", "ln_s", "ln_sf"],
]);
/** Names specific enough to count with no receiver (and Perl and PHP builtins, which have none). */
const BARE_CALLS =
  /^(?:rmtree|rmSync|unlinkSync|rmdirSync|renameSync|copyFileSync|cpSync|writeFileSync|appendFileSync|truncateSync|chmodSync|chownSync|symlinkSync|linkSync|file_put_contents|remove_tree|rimraf|unlink|rmdir|rename|chmod|chown|chdir|truncate|symlink|link|copy|fopen)$/;
/** Receivers whose file calls count (`os.remove`, `shutil.rmtree`, `fs.rmSync`, `FileUtils.rm_rf`). */
const RECEIVERS = /^(?:os|shutil|fs|fsp|promises|File|FileUtils|Dir|IO|Pathname)$/;
const FILE_CALL =
  /(?:\b([A-Za-z_]\w*)\s*\.\s*)?\b(remove|unlink|rmtree|rmdir|removedirs|rmSync|unlinkSync|rmdirSync|rm_rf|rm_r|rm_f|rm|remove_tree|rimraf|delete|rename|renames|replace|move|copy|copyfile|copy2|copytree|renameSync|copyFileSync|cpSync|copyFile|mv|cp|cp_r|writeFileSync|appendFileSync|writeFile|appendFile|write|binwrite|write_text|write_bytes|file_put_contents|truncate|truncateSync|chmod|chmodSync|chown|chownSync|chdir|touch|symlink|symlinkSync|link|linkSync|ln_s|ln_sf|open|fopen|glob)\b(\s*\(|[ \t]+(?=[$'"\w]))/g;
/**
 * Method names that are file calls on any receiver: in the APIs that have them they mean nothing
 * else (`require('fs').rmSync(x)`, `fsp.rm(x)`, `x.rmtree()`).
 */
const FILE_METHODS =
  /^(?:rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir|rmtree|removedirs|renameSync|renames|writeFileSync|appendFileSync|writeFile|appendFile|truncateSync|chmodSync|chownSync|copyFileSync|copyFile|cpSync|symlinkSync|linkSync|rm_rf|rm_r|rm_f|cp_r|ln_s|ln_sf|file_put_contents|copytree|copyfile|copy2|chdir|write_text|write_bytes)$/;
/** A call chain that starts by loading a module: `require('fs').`, `__import__('os').`. */
const LOADED = /\b(?:require|__import__|import_module)\s*\([^()]*\)(?:\s*\.\s*\w+)*\s*\.\s*$/;

/** Names bound to a module: `import os as o`, `const f = require('fs')`, `m = __import__('os')`. */
function moduleAliases(code: string): Set<string> {
  const found = new Set<string>();
  for (const match of code.matchAll(/\bimport\s+[\w.]+\s+as\s+(\w+)/g))
    found.add(match[1] as string);
  for (const match of code.matchAll(
    /\b\$?(\w+)\s*=\s*(?:require|__import__|importlib\s*\.\s*import_module|import_module)\s*\(/g,
  ))
    found.add(match[1] as string);
  return found;
}

/** Methods that act on the path object they are called on (`Path('/x').unlink()`, `p.write_text(...)`). */
const PATH_METHODS =
  /^(?:unlink|rmdir|write_text|write_bytes|rename|replace|touch|chmod|symlink_to)$/;

/**
 * The value of a plain string literal (`'x'`, `"x"`, `r'x'`), or undefined for anything else:
 * an f-string, a template or interpolating string, concatenation, a call, a variable.
 */
function plainLiteral(text: string): string | undefined {
  const arg = text.trim();
  const prefix = /^[rRbBuU]{0,2}/.exec(arg)?.[0] ?? "";
  const quote = arg[prefix.length];
  if ((quote !== "'" && quote !== '"') || arg.length < prefix.length + 2) return undefined;
  if (arg[arg.length - 1] !== quote) return undefined;
  const inner = arg.slice(prefix.length + 1, -1);
  if (inner.includes(quote) || inner.includes("\\")) return undefined;
  if (quote === '"' && /\$|#\{/.test(inner)) return undefined;
  return inner;
}

/**
 * The arguments of a call from `start` (just after its `(`, or after the name for a call without
 * parentheses), split at top-level commas. Undefined when they cannot be read within the limit.
 */
function callArgs(code: string, start: number, parens: boolean): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let quote = "";
  let from = start;
  const end = Math.min(code.length, start + MAX_TARGET);
  for (let i = start; i < end; i++) {
    const c = code[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) || (!parens && (c === ";" || c === "\n") && depth === 0)) {
      if (depth === 0) {
        args.push(code.slice(from, i));
        return args;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(code.slice(from, i));
      from = i + 1;
    }
  }
  if (!parens && end === code.length) {
    args.push(code.slice(from, end));
    return args;
  }
  return undefined;
}

/** Variables assigned exactly once, to a plain string literal: `p = '/x'`, `const p = "/x"`. */
function literalVariables(code: string): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  for (const line of code.split(/[\n;]/)) {
    const match = /^\s*(?:(?:const|let|var|my|our)\s+)?\$?([A-Za-z_]\w*)\s*=(?!=)(.*)$/.exec(line);
    if (!match) continue;
    const [, name = "", value = ""] = match;
    found.set(name, found.has(name) ? undefined : plainLiteral(value));
  }
  return found;
}

/**
 * Whether a file call in the code deletes, moves, copies, writes or enters a path that could be
 * the state, or one this cannot read as a plain string literal (concatenation, `chr()`, `os.sep`,
 * `join`, an f-string, a variable not assigned a literal once, a `listdir`/`walk` result): the
 * state lies in the temp directory, so a computed path fails closed.
 */
function callsReachState(code: string, cwds: string[]): boolean {
  const vars = literalVariables(code);
  const aliases = moduleAliases(code);
  const value = (arg: string): string | undefined => {
    const name = /^\s*\$?([A-Za-z_]\w*)\s*$/.exec(arg)?.[1];
    if (name) return vars.get(name);
    const path = /^\s*(?:pathlib\s*\.\s*)?Path\s*\((.*)\)\s*$/.exec(arg)?.[1];
    if (path !== undefined) return value(path);
    return plainLiteral(arg);
  };
  const reaches = (arg: string | undefined) => {
    if (arg === undefined) return true;
    const path = value(arg);
    return path === undefined || namesState(path, cwds, true);
  };
  for (const match of code.matchAll(FILE_CALL)) {
    const [whole, receiver, name = "", opener = ""] = match;
    const at = (match.index ?? 0) + whole.length;
    const parens = opener.includes("(");
    // Without parentheses only Ruby's `FileUtils.rm_rf dir`, `File.delete f` and Perl's
    // `unlink $f`/`unlink glob(...)` forms count, so prose in a string or comment does not.
    if (
      !parens &&
      !(receiver && RECEIVERS.test(receiver)) &&
      !(/^(?:unlink|rmdir)$/.test(name) && /^[$'"]|^glob\b/.test(code.slice(at)))
    )
      continue;
    const index = match.index ?? 0;
    const before = code.slice(Math.max(0, index - MAX_TARGET), index);
    // A method on an expression: `Path('/x').unlink()`, `require('fs').rmSync(x)`.
    const dotted = !receiver && /\.\s*$/.test(before.slice(-8));
    // The path object a method is called on, when it is `Path(<literal>)`.
    const pathObject = () =>
      /Path\s*\(([^()]*)\)\s*\.?\s*$/.exec(before.replace(/\s*\.\s*$/, ""))?.[1];
    // A module, an alias of one, or a chain that starts by loading one: any name is a file call.
    const moduleCall =
      (receiver !== undefined && (RECEIVERS.test(receiver) || aliases.has(receiver))) ||
      (dotted && LOADED.test(before.slice(-200)));
    if (dotted && !moduleCall && !FILE_METHODS.test(name)) {
      if (!PATH_METHODS.test(name)) continue;
      // `.replace(...)`/`.rename(...)` on anything but a `Path(...)` is a string or table method.
      const object = pathObject();
      if (object === undefined && /^(?:replace|rename)$/.test(name)) continue;
      if (reaches(object)) return true;
      continue;
    }
    if (name === "glob" || name === "open" || name === "fopen" || name === "write") {
      // A glob only finds names; `open`/`fopen`/`File.write` write only in a write mode.
      if (name === "glob") continue;
      const args = callArgs(code, at, parens);
      if (!args) return true;
      if (name === "write") {
        if (receiver !== "File" && receiver !== "IO") continue;
      } else {
        const mode = args[1];
        if (mode === undefined) continue;
        const literal = plainLiteral(mode);
        if (literal !== undefined && !/[wax+]/.test(literal)) continue;
      }
      if (reaches(args[0])) return true;
      continue;
    }
    const fileCall =
      moduleCall ||
      ((receiver !== undefined || dotted) && FILE_METHODS.test(name)) ||
      (receiver === undefined && !dotted && BARE_CALLS.test(name));
    if (!fileCall) {
      // A method on a path object: `p.write_text(...)`. On a plain variable, `replace` and
      // `rename` are string methods far more often than path ones.
      if (!receiver || !PATH_METHODS.test(name) || /^(?:replace|rename)$/.test(name)) continue;
      if (reaches(pathObject() ?? receiver)) return true;
      continue;
    }
    // A path object's own method (`p.unlink()`, `Path(x).write_text(s)`) acts on the object.
    if (!moduleCall && (receiver !== undefined || dotted) && PATH_METHODS.test(name)) {
      if (reaches(pathObject() ?? receiver)) return true;
      continue;
    }
    const args = callArgs(code, at, parens);
    if (!args) return true;
    const count = TWO_PATHS.has(name) ? 2 : 1;
    for (let i = 0; i < count; i++) if (reaches(args[i])) return true;
  }
  return false;
}

/**
 * Whether inline interpreter code could change the state. It names `acp`; or it deletes, moves or
 * writes files and either computes the temp directory at run time (an environment variable or an
 * API: the result is the directory the state lies in), or names a path that could reach the state
 * the way a shell target does: a state directory, a directory above one (the temp root itself), a
 * glob matching one, or a path built at run time (`f'/tmp/{x}'`, `'/tmp/' + x`, `"$TMPDIR/$x"`,
 * read as a glob). A literal path into another directory in temp (`/tmp/pm-x/notes.md`) is not.
 */
export function codeTouchesState(code: string, cwds: Iterable<string>): boolean {
  if (code.length > MAX_CODE) return true;
  if (/\bacp/i.test(code)) return true;
  const roots = [...cwds];
  if (callsReachState(code, roots.length ? roots : ["/"])) return true;
  // Dynamic import or attribute indirection hides which call runs (`__import__`, `getattr`,
  // `require(x)`, `eval`, `Function`): with a temp lookup or a path built at run time, fail closed.
  if (
    /__import__\s*\(|\bimportlib\b|\bgetattr\s*\(|\brequire\s*\(\s*[^'"\s)]|\beval\s*\(|\bexec\s*\(|\bFunction\s*\(|\bsend\s*\(|\bcall_user_func/.test(
      code,
    ) &&
    (TEMP_LOOKUP.test(code) ||
      /['"]\s*\+|\+\s*['"]|\bos\.sep\b|\bchr\s*\(|\.join\s*\(|\bf['"]|`[^`]*\$\{/.test(code) ||
      /['"]\/(?:tmp|var|private)\b/.test(code))
  )
    return true;
  const changes =
    /unlink|remove|rmtree|rmdir|\brm\b|rmSync|rename|truncate|writeFile|open\s*\(|shutil|glob|listdir|walk|readdir|system|exec|spawn|subprocess/i.test(
      code,
    );
  if (!changes) return false;
  // The temp directory computed at run time (case matters: `/tmp` in a path is not `TMP`).
  if (TEMP_LOOKUP.test(code)) return true;
  const list = [...cwds];
  for (const match of code.matchAll(/(?:~\/|\/)[\w.*?[\]{}$%-][^\s'"`,;)(]*/g)) {
    // Parts filled in at run time are any name: `{x}`, `%s`, `$x`; a path that ends where code
    // goes on (`'/tmp/' + x`) keeps its trailing `/` and is read as the directory.
    if (match[0].length > MAX_TARGET) return true;
    const path = match[0].replace(/\{[^}/]*\}|%[sd]|\$\{?\w*\}?/g, "*");
    if (namesState(path, list.length ? list : ["/"], true)) return true;
  }
  return false;
}
