import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, posix } from "node:path";
import { maskStrings, withoutStrings } from "./clirun.js";
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
/** A path with a session directory name in it, wherever it lies. */
const STATE_NAME = /(?:^|[\\/])acp-(?:\d+|user)-[^\\/]*(?:[\\/]|$)/i;
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

/**
 * Code that can produce a temp path for a file call this cannot read: temp named outright, a
 * parent step (`..`), paths read from outside the code (argv, environment, standard input, a
 * directory listing, a glob), or text decoded or rebuilt at run time.
 */
const TEMP_HINT =
  /tmp|temp|\/var|\/private|folders|acp|\.\.|argv|environ|process\.env|getenv|ENV\[|\$\{?\w|stdin|\binput\s*\(|readline|listdir|scandir|walk|readdir|\bglob\b|\bchr\s*\(|fromCharCode|base64|b64|fromhex|codecs|decode|unhexlify|pack\s*\(|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|\\[0-7]{3}|%[0-9a-f]{2}|\[::-1\]|reverse|rot13|translate|maketrans|expandvars|\bbytes\s*\(|bytearray|%c|\bord\s*\(|struct|marshal|pickle|zlib|gzip|bz2|lzma|Buffer\.from|atob|unescape/i;

/**
 * The path-like quoted strings in the code (short, no spaces), joined in order, so a name split
 * across literals (`'/t' + 'mp'`) reads whole. Text being written (source, messages) is left out.
 */
function joinedStrings(code: string): string {
  let out = "";
  for (const match of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g)) {
    const text = match[1] ?? match[2] ?? match[3] ?? "";
    if (text.length <= 200 && !/\s/.test(text)) out += text;
  }
  return out;
}

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

/**
 * The path a literal expression names, or undefined: a plain string literal, `Path(<literal>)` or
 * `pathlib.Path(<literal>)`, `open(<literal>[, mode])` (the file it opens), or `os.path.join` of
 * literals only. Anything computed (a variable, `Path.cwd()`, concatenation, an f-string) is not.
 */
function literalPath(text: string, argv: Array<string | undefined> = []): string | undefined {
  const expr = text.trim();
  // `process.argv[1]` (node -e) and `sys.argv[1]` (python -c, python -) are the first word after
  // the code, when the shell passed a literal one.
  const arg = /^(?:process\s*\.\s*argv|sys\s*\.\s*argv)\s*\[\s*([1-9])\s*\]$/.exec(expr);
  if (arg) return argv[Number(arg[1]) - 1];
  // The arguments of a call that is the whole expression: `Path(x)`, not `Path(x).read_text()`.
  const call = (pattern: RegExp) => {
    const match = pattern.exec(expr);
    if (!match) return undefined;
    const args = callArgs(expr, match[0].length, true);
    if (!args) return undefined;
    const end = match[0].length + args.join(",").length;
    return expr[end] === ")" && end === expr.length - 1 ? args : undefined;
  };
  const wrapped = call(/^(?:pathlib\s*\.\s*)?Path\s*\(/) ?? call(/^open\s*\(/);
  if (wrapped) {
    const [first] = wrapped;
    return first === undefined ? undefined : plainLiteral(first);
  }
  const joined = call(/^os\s*\.\s*path\s*\.\s*join\s*\(/);
  if (joined) {
    const parts = joined.map(plainLiteral);
    if (!parts.length || parts.some((part) => part === undefined)) return undefined;
    return posix.join(...(parts as string[]));
  }
  return plainLiteral(expr);
}

/**
 * Variables whose every assignment is a literal path (`literalPath`): `p = '/x'`,
 * `const p = "/x"`, `p = Path('/x')`, `f = open('/x', 'w')`, `p = os.path.join('/tmp', 'x')`,
 * `f = process.argv[1]` with a literal word there. The value is one of them wherever it is read. A
 * name that is also bound another way (a parameter, a loop or `with ... as` target, destructuring,
 * an augmented assignment) has no known value.
 */
function literalVariables(
  code: string,
  argv: Array<string | undefined> = [],
  interpreter = "",
): Map<string, string[] | undefined> {
  const found = new Map<string, string[] | undefined>();
  // Bindings are read outside string literals: text being written (source code with its own
  // `(p) =>` or `p = x`) is data. Values are read back from the code at the same positions.
  const masked = maskStrings(code, interpreter);
  const plain = new Map<string, number>();
  for (const segment of masked.matchAll(/[^\n;]+/g)) {
    const match = /^\s*(?:(?:const|let|var|my|our)\s+)?\$?([A-Za-z_]\w*)\s*=(?!=)/.exec(segment[0]);
    if (!match) continue;
    const at = (segment.index ?? 0) + match[0].length;
    const name = match[1] ?? "";
    const value = code.slice(at, (segment.index ?? 0) + segment[0].length);
    const path = literalPath(value, argv);
    // Every statement-level binding of a name to a literal adds a value it may hold; one binding to
    // anything else makes it unknown.
    const known = found.get(name);
    found.set(
      name,
      path === undefined || (found.has(name) && !known) ? undefined : [...(known ?? []), path],
    );
    plain.set(name, (plain.get(name) ?? 0) + 1);
  }
  // Only those bindings: any other assignment to the name, wherever it is (`if 1: p = x`, a
  // walrus, `+=`, destructuring, `global`/`nonlocal`), makes its value unknown.
  for (const name of found.keys()) {
    const word = `\\b${name}\\b`;
    const assignments = masked.match(
      new RegExp(`${word}\\s*(?:[-+*/%&|^@:]|\\*\\*|//|<<|>>|\\?\\?|\\|\\||&&)?=(?!=)`, "g"),
    );
    if (
      (assignments?.length ?? 0) !== plain.get(name) ||
      new RegExp(
        `\\b(?:global|nonlocal)\\b[^\\n;]*${word}|[[{(][^\\]})\\n]*${word}[^\\]})\\n]*[\\]})]\\s*=(?!=)`,
      ).test(masked)
    )
      found.set(name, undefined);
  }
  const bound = (list: string) => {
    for (const name of list.split(/[\s,()[\]{}*=:.]+/))
      if (/^[A-Za-z_]\w*$/.test(name)) found.set(name, undefined);
  };
  for (const match of masked.matchAll(
    /\b(?:def|function)\s*\w*\s*\(([^)]*)\)|\(([^()]*)\)\s*=>|\b(\w+)\s*=>|\bfor\s*\(?\s*(?:const|let|var|my|our)?\s*([\w\s,$[\]{}]+?)\s+(?:in|of)\b|\bas\s+(\w+)|\bcatch\s*\((\w+)|(?:const|let|var)\s*([[{][^=]*)=|\blambda\b([^:]*):|\b(\w+)\s*(?:[-+*/%|&^]|\*\*|\/\/|<<|>>)=|\bglobal\s+([\w\s,]+)|(?:^|[\n;])\s*(\w+(?:\s*,\s*\w+)+)\s*,?\s*=(?!=)/g,
  ))
    for (const group of match.slice(1)) if (group) bound(group);
  return found;
}

/**
 * Whether a file call in the code deletes, moves, copies, writes or enters a path that could be
 * the state, or one this cannot read as a plain string literal (concatenation, `chr()`, `os.sep`,
 * `join`, an f-string, a variable not assigned a literal once, a `listdir`/`walk` result): the
 * state lies in the temp directory, so a computed path fails closed.
 */
function callsReachState(
  code: string,
  cwds: string[],
  given: Array<string | undefined> = [],
  interpreter = "",
): boolean {
  let argv = given;
  // Words after the code stand for `process.argv`/`sys.argv` only while the code never changes it.
  if (
    /argv\s*(?:\[[^\]]*\]\s*(?:[-+*/%]?=(?!=))|=(?!=)|\.\s*(?:splice|push|shift|unshift|pop|insert|remove|append|extend|reverse|sort|clear|fill|copyWithin)\b)|\bdel\s+sys\s*\.\s*argv|\bargv\s*\[[^\]]*:/.test(
      code,
    )
  )
    argv = [];
  const vars = literalVariables(code, argv, interpreter);
  const aliases = moduleAliases(code);
  const values = (arg: string): string[] | undefined => {
    const name = /^\s*\$?([A-Za-z_]\w*)\s*$/.exec(arg)?.[1];
    if (name) return vars.get(name);
    const path = literalPath(arg, argv);
    return path === undefined ? undefined : [path];
  };
  // A path this cannot read can only lead to the state if the code can produce a temp path: it
  // names temp (also split across literals: '/t' + 'mp'), reads paths from outside (argv, the
  // environment, standard input, a listing), or decodes text. Without any of that, every string
  // the path is built from is visible here and none points at temp.
  const hinted =
    TEMP_HINT.test(withoutStrings(code, interpreter)) ||
    // In a string, `${name}` is template text (data) unless the name itself points at temp.
    TEMP_HINT.test(joinedStrings(code).replace(/\$\{?(\w+)\}?/g, "$1"));
  // A path this cannot read is safe only when it starts from a visible directory that neither
  // holds nor lies above a session directory: `b + path` with `b = '/repo/src/'`, `f'src/{x}'`,
  // `os.path.join('/repo', x)`, `Path('/repo') / x`. Whatever follows can only go deeper, since a
  // `..` anywhere makes the code hinted. A prefix like `'/t'` names `/`, which lies above the
  // state, so reordered fragments (`'/t' + 'mp' + …`) still fail closed.
  const anchored = (arg: string): boolean => {
    const text = arg.trim();
    const first =
      /^(?:os\s*\.\s*path\s*\.\s*join|path\s*\.\s*(?:join|resolve)|join)\s*\(\s*([^,()]+)/.exec(
        text,
      )?.[1] ??
      /^(?:pathlib\s*\.\s*)?Path\s*\(\s*([^()]+?)\s*\)\s*\//.exec(text)?.[1] ??
      text;
    const lead =
      /^\s*(?:(f|r|rf|fr|b)?(['"])((?:(?!\2)[^\\\n])*)\2|`([^`$]*)|([A-Za-z_]\w*))/i.exec(first);
    if (!lead) return false;
    let prefixes: string[] | undefined;
    if (lead[5] !== undefined) prefixes = vars.get(lead[5]);
    else {
      const body = lead[4] ?? lead[3] ?? "";
      prefixes = [
        /f/i.test(lead[1] ?? "") || lead[4] !== undefined ? (body.split("{")[0] ?? "") : body,
      ];
    }
    if (!prefixes?.length) return false;
    const states = stateDirs().map(fold);
    return prefixes.every((prefix) => {
      if (prefix.includes("..")) return false;
      const dir = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      return cwds.every((cwd) => {
        // No `..` can occur here, so joining is resolving (also for a Windows drive path).
        const base = slashes(dir);
        let abs = (/^(?:\/|[A-Za-z]:\/)/.test(base) ? base : `${slashes(cwd)}/${base}`)
          .replace(/\/(?:\.\/)+/g, "/")
          .replace(/\/{2,}/g, "/");
        try {
          abs = slashes(canonical(abs));
        } catch {
          /* a directory not created yet keeps its lexical form */
        }
        const at = fold(trim(abs));
        if (!at || at === "/") return false;
        return !states.some(
          (state) => state === at || state.startsWith(`${at}/`) || at.startsWith(`${state}/`),
        );
      });
    });
  };
  const reaches = (arg: string | undefined) => {
    if (arg === undefined) return true;
    const paths = values(arg);
    // A session directory by its name counts too, also one not created yet or another user's.
    if (paths === undefined) return hinted || !anchored(arg);
    return paths.some((path) => STATE_NAME.test(path) || namesState(path, cwds, true));
  };
  // Calls are found outside string literals (a message or source text being edited is data);
  // their arguments are read from the code itself.
  for (const match of maskStrings(code, interpreter).matchAll(FILE_CALL)) {
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
    // A method on what `open(...)` returns (`open(p, encoding="utf-8").read()`) acts on the file
    // that call opened, and the `open` call itself is judged on its own.
    if (dotted && /(?:^|[^\w.])open\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*$/.test(before)) continue;
    // The path object a method is called on, when it is `Path(<literal>)`.
    const pathObject = () =>
      /Path\s*\(([^()]*)\)\s*\.?\s*$/.exec(before.replace(/\s*\.\s*$/, ""))?.[1];
    // A module, an alias of one, or a chain that starts by loading one: any name is a file call.
    const moduleCall =
      (receiver !== undefined && (RECEIVERS.test(receiver) || aliases.has(receiver))) ||
      (dotted && LOADED.test(before.slice(-200)));
    if (dotted && !moduleCall && !FILE_METHODS.test(name)) {
      if (!PATH_METHODS.test(name)) continue;
      // `.replace(...)`/`.rename(...)` on anything but a `Path(...)` is a string or table method,
      // and so is one with two or more arguments: `Path.replace`/`rename` take one target.
      const object = pathObject();
      if (/^(?:replace|rename)$/.test(name)) {
        if (object === undefined) continue;
        const args = callArgs(code, at, parens);
        if (args && args.length >= 2) continue;
      }
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
 * Code that can start a process or evaluate a string, so names in its text may become commands or
 * file calls this cannot read.
 */
/**
 * A call this cannot name: a computed member (`fs['rm'+'Sync'](x)`), a module function under
 * another name (`import os as o`, `from os import remove as r`, `f = os.remove`), Ruby `send`,
 * Perl symbolic calls (`&$f`, `->$m`), PHP variable functions (`$f(x)`).
 */
export const INDIRECT_CALL =
  /\]\s*\(|\bgetattr\s*\(|\bimport\s+[\w.]+\s+as\b|\bfrom\s+[\w.]+\s+import\b[^\n]*\bas\b|=\s*(?:os|shutil|fs|fsp|promises|pathlib|Path|FileUtils|File|Dir)\s*\.\s*\w+\s*(?:$|[;,)\n])|\b(?:public_send|__send__)\b|\.send\s*[(:]|\bmethod\s*\(\s*:|&\$\w|&\{|->\s*\$|\$\w+\s*\(|\bcall_user_func/m;
export const RUNS_CODE =
  /child_process|subprocess|\bspawn|\bexec(?:Sync|File\w*|[lv]p?e?)?\s*\(|\bsystem\s*[("'$]|\bpopen|Popen|\bpty\b|\bcommands\s*\.|shell_exec|passthru|proc_open|\bqx\b|%x[({[]|\bIO\s*\.\s*popen|Bun\s*\.|Deno\s*\.|\beval\b|\bFunction\s*\(|\bvm\s*\.|\bWorker\s*\(|__import__|importlib|\bgetattr\s*\(|\bcompile\s*\(|\brequire\s*\(\s*[^'"\s)]|\bimport\s*\(\s*[^'"\s)]|\bsend\s*\(|call_user_func|\bos\s*\.\s*(?:system|popen|exec|spawn|posix_spawn|fork)|\bReflect\b|\.\s*(?:call|apply|bind)\s*\(/;
/** A module member that is not called (`const r = fs.rmSync`) or a computed one (`fs["rmSync"]`). */
const UNCALLED_MEMBER =
  /\b(?:fs|fsp|os|shutil|promises|pathlib|FileUtils|File|Dir|IO|Pathname)\s*(?:\.\s*\w+\b(?!\s*[.(\w])|\[)|\bimport\s+\*|\buse\s+File::|\brequire\s+["']fileutils/;
/** Names that change files: an imported one is a file call this only follows by its own name. */
const FILE_NAME =
  /^(?:rm|unlink|rmdir|remove|move|copy|cp|mv|rename|replace|truncate|symlink|link|chmod|chown|chdir|touch|open|fopen|write|append|output|empty|ensure|mk|copytree|copyfile|copy2|rmtree|removedirs|renames)/i;
/**
 * Whether code reaches a file function other than by a call `callsReachState` reads: an uncalled
 * or computed module member, a wildcard import, or a file function imported under another name, or
 * one whose name is not a bare call read there (`const { rm } = require("fs/promises")`,
 * `from os import remove`).
 */
function hiddenFileCall(code: string): boolean {
  if (UNCALLED_MEMBER.test(code)) return true;
  const lists = [
    ...code.matchAll(/\bimport\s*(?:\w+\s*,\s*)?\{([^}]*)\}\s*from/g),
    ...code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:require|await\s+import)\s*\(/g),
    ...code.matchAll(/\bfrom\s+[\w.]+\s+import\s+\(?([\w\s,]+)\)?/g),
  ];
  for (const match of lists)
    for (const item of (match[1] ?? "").split(",")) {
      const [name = "", local = name] = item
        .trim()
        .split(/\s+as\s+|\s*:\s*/)
        .map((part) => part.trim());
      if (!name || !FILE_NAME.test(name)) continue;
      if (local !== name || !BARE_CALLS.test(name)) return true;
    }
  return false;
}

/** The code with each `os.path.join` of literals only replaced by its joined path, quoted. */
function joinedLiterals(code: string): string {
  let out = "";
  let from = 0;
  for (const match of code.matchAll(/\bos\s*\.\s*path\s*\.\s*join\s*\(/g)) {
    const at = match.index ?? 0;
    if (at < from) continue;
    const args = callArgs(code, at + match[0].length, true);
    if (!args) continue;
    const end = at + match[0].length + args.join(",").length;
    if (code[end] !== ")") continue;
    const path = literalPath(code.slice(at, end + 1));
    if (path === undefined) continue;
    out += `${code.slice(from, at)}'${path}'`;
    from = end + 1;
  }
  return out + code.slice(from);
}

/**
 * Whether inline interpreter code could change the state. It names `acp`; or it deletes, moves or
 * writes files and either computes the temp directory at run time (an environment variable or an
 * API: the result is the directory the state lies in), or names a path that could reach the state
 * the way a shell target does: a state directory, a directory above one (the temp root itself), a
 * glob matching one, or a path built at run time (`f'/tmp/{x}'`, `'/tmp/' + x`, `"$TMPDIR/$x"`,
 * read as a glob). A literal path into another directory in temp (`/tmp/pm-x/notes.md`) is not.
 */
export function codeTouchesState(
  code: string,
  cwds: Iterable<string>,
  options: { argv?: Array<string | undefined>; interpreter?: string } = {},
): boolean {
  if (code.length > MAX_CODE) return true;
  const roots = [...cwds];
  if (callsReachState(code, roots.length ? roots : ["/"], options.argv, options.interpreter))
    return true;
  // Code that only calls the file functions read above, each on a literal path that is not the
  // state, cannot change the state: text that names `acp`, or a path, is data there. Code that
  // starts processes, evaluates strings, or reaches a file function some other way (an imported
  // name, a reference that is not a call) is judged by everything it names.
  const bare = withoutStrings(code, options.interpreter);
  if (
    !RUNS_CODE.test(bare) &&
    !INDIRECT_CALL.test(bare) &&
    !(
      code.includes("`") &&
      !/^(?:node|nodejs|deno|bun|python[\d.]*)$/i.test(options.interpreter ?? "")
    ) &&
    !hiddenFileCall(bare) &&
    !TEMP_LOOKUP.test(bare)
  )
    return false;
  if (/\bacp/i.test(code)) return true;
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
  // `os.path.join('/tmp', 'x')` names /tmp/x, not the temp root: read literal joins as one path.
  const text = joinedLiterals(code);
  for (const match of text.matchAll(/(?:~\/|\/)[\w.*?[\]{}$%-][^\s'"`,;)(]*/g)) {
    // Parts filled in at run time are any name: `{x}`, `%s`, `$x`; a path that ends where code
    // goes on (`'/tmp/' + x`) keeps its trailing `/` and is read as the directory.
    if (match[0].length > MAX_TARGET) return true;
    const path = match[0].replace(/\{[^}/]*\}|%[sd]|\$\{?\w*\}?/g, "*");
    if (namesState(path, list.length ? list : ["/"], true)) return true;
  }
  return false;
}

/** Audit logs: the only files in a session directory a read may name. */
const AUDIT_FILE = /^audit(?:\.\d+)?\.jsonl$/i;
let secrets: { from: string[]; at: number; targets: string[] } | undefined;
/**
 * Every file in a session directory except its audit logs, folded: the token, the socket, grants
 * and anything else there, plus a sample name for files a later version may add.
 */
function secretTargets(): string[] {
  const from = stateDirs();
  if (secrets?.from === from && Date.now() - secrets.at < 2000) return secrets.targets;
  const targets: string[] = [];
  for (const dir of from) {
    const names = new Set(["token", "service.sock", "grants.json", "x"]);
    try {
      for (const name of readdirSync(dir)) names.add(name);
    } catch {
      /* a sample or unreadable directory: the known names still count */
    }
    for (const name of names) if (!AUDIT_FILE.test(name)) targets.push(fold(`${dir}/${name}`));
  }
  secrets = { from, at: Date.now(), targets };
  return targets;
}

/**
 * Whether reading `text` (as the shell would expand it: a glob, a variable read as `*`) could read
 * the policy service's secrets: any file in a session directory but its audit logs, above all the
 * session token, which authenticates grants. With `whole` (a recursive reader, or a directory
 * read as a tree) the session directory itself and the directories above it count too.
 */
export function namesStateSecret(text: string, cwds: Iterable<string>, whole: boolean): boolean {
  if (!text) return false;
  // Too long to match in time: only a word that could expand, or names the state, fails closed.
  if (text.length > MAX_TARGET) return /acp|[*?[{]/i.test(text);
  if (/^-[^=]*$|^\d+$/.test(text)) return false;
  const list = [...cwds];
  const memo = stateLists().names;
  const key = `secret${whole ? 1 : 0}\0${text}\0${list.join("\0")}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const answer = namesStateSecretOnce(text, list, whole);
  if (memo.size < 20_000) memo.set(key, answer);
  return answer;
}
function namesStateSecretOnce(text: string, cwds: string[], whole: boolean): boolean {
  const { dirs, above, dirSet, aboveSet } = stateLists();
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
      // A session directory by its name, also one created since the lists were read.
      const parts = form.split("/");
      const at = parts.findIndex((part) => STATE_DIR.test(part));
      if (at >= 0) {
        const rest = parts.slice(at + 1).filter(Boolean);
        if (rest.length === 0 ? whole : rest.length > 1 || !AUDIT_FILE.test(rest[0] ?? ""))
          return true;
      }
      for (const dir of dirSet) {
        if (form === dir) {
          if (whole) return true;
          continue;
        }
        if (!form.startsWith(`${dir}/`)) continue;
        const rest = form.slice(dir.length + 1).split("/");
        if (rest.length > 1 || !AUDIT_FILE.test(rest[0] ?? "")) return true;
      }
      if (whole && aboveSet.has(form)) return true;
      continue;
    }
    if (secretTargets().some((target) => pathMatch(form, target, true))) return true;
    if (whole && dirs.some((dir) => pathMatch(form, dir, false))) return true;
    if (whole && above.some((dir) => pathMatch(form, dir, false))) return true;
  }
  return false;
}

/**
 * Calls inline code may make and still create no symlink: reading and writing whole files and
 * plain string, list, dict and JSON work. Anything else (archive extraction, links, renames,
 * copies, processes, any library call not listed) may create one.
 */
const LINK_FREE_CALLS = new Set([
  ...["open", "read", "write", "close", "print", "len", "str", "int", "float", "bool", "repr"],
  ...["list", "dict", "set", "tuple", "sorted", "reversed", "range", "enumerate", "zip", "min"],
  ...["max", "sum", "any", "all", "isinstance", "replace", "split", "rsplit", "splitlines"],
  ...["join", "strip", "lstrip", "rstrip", "startswith", "endswith", "format", "lower", "upper"],
  ...["find", "rfind", "index", "count", "encode", "decode", "append", "extend", "insert", "pop"],
  ...["get", "items", "keys", "values", "update", "loads", "dumps", "load", "dump", "search"],
  ...["match", "fullmatch", "sub", "subn", "findall", "finditer", "compile", "group", "groups"],
  ...["exit", "read_text", "write_text", "exists", "is_file", "readlines", "writelines"],
  ...["readFileSync", "writeFileSync", "appendFileSync", "existsSync", "log", "error", "parse"],
  ...["stringify", "includes", "indexOf", "lastIndexOf", "slice", "substring", "map", "filter"],
  ...["forEach", "push", "trim", "trimEnd", "trimStart", "toString", "test", "replaceAll"],
  ...["padStart", "padEnd", "some", "every", "reduce", "flatMap", "concat", "Error", "String"],
  ...["Number", "Boolean", "Array", "Object", "Set", "Map", "JSON", "Path", "require"],
]);
/** Modules inline code may load: their link-creating calls are not on the list above. */
const LINK_FREE_MODULES =
  /^(?:re|json|sys|os|pathlib|textwrap|collections|fs|path|node:fs|node:path)$/;
/**
 * Whether inline interpreter code (Python or Node) can create no symlink: it loads only listed
 * modules, and every call it makes (bare or as a method) is on the link-free list. Unsure is no.
 */
export function codeLinkFree(code: string, interpreter: string): boolean {
  if (code.length > MAX_CODE || !/^(?:python[\d.]*|node|nodejs)$/.test(interpreter)) return false;
  const bare = withoutStrings(code, interpreter);
  if (RUNS_CODE.test(bare) || hiddenFileCall(bare)) return false;
  for (const match of code.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/gm))
    for (const name of (match[1] ?? match[2] ?? "").split(/[\s,]+/).filter(Boolean))
      if (!LINK_FREE_MODULES.test(name.split(" as ")[0] ?? name)) return false;
  for (const match of code.matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g))
    if (!LINK_FREE_MODULES.test(match[1] ?? "")) return false;
  if (/\bimport\s*\(|\bimport\s+[\w{*]/.test(bare) && interpreter.startsWith("node")) return false;
  for (const match of bare.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1] ?? "";
    if (
      /^(?:if|for|while|switch|return|catch|function|def|print|elif|not|and|or|in|with|lambda)$/.test(
        name,
      )
    )
      continue;
    if (!LINK_FREE_CALLS.has(name)) return false;
  }
  return true;
}
