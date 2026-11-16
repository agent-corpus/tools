import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * counts too.
 */
export function stateDirs(): string[] {
  if (cache && cache.temp === tmpdir() && Date.now() - cache.at < 2000) return cache.dirs;
  const uid = String(process.getuid?.() ?? "user");
  const dirs = new Set<string>();
  try {
    dirs.add(`${trim(slashes(canonical(tmpdir())))}/acp-${uid}-0123456789abcdef01234567`);
  } catch {
    /* no temp directory */
  }
  for (const root of tempRoots()) {
    try {
      for (const name of readdirSync(root))
        if (STATE_DIR.test(name)) dirs.add(`${trim(slashes(root))}/${name}`);
    } catch {
      /* unreadable: the sample still counts */
    }
  }
  cache = { at: Date.now(), temp: tmpdir(), dirs: [...dirs] };
  return cache.dirs;
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
function tokenize(pattern: string): Token[] | undefined {
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
  const go = (a: number, b: number): boolean => {
    if (b === ts.length) return a === ps.length || (inside && a > 0) || ps[a] === "**";
    if (a === ps.length) return false;
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
  const fold = (path: string) => (WINDOWS ? path.toLowerCase() : path);
  const dirs = stateDirs().map(fold);
  const above = removes ? stateAncestors().map(fold) : [];
  const forms = new Set<string>();
  for (const cwd of cwds) {
    let path: string;
    try {
      path = slashes(resolveWord(cwd, text));
    } catch {
      continue;
    }
    forms.add(trim(path));
    try {
      forms.add(trim(slashes(canonical(path))));
    } catch {
      /* judged as written */
    }
  }
  for (const raw of forms) {
    const form = fold(raw);
    if (!hasGlob(form)) {
      // A literal path: a state directory, anything in one, or (for a delete) a directory above.
      if (dirs.some((dir) => form === dir || form.startsWith(`${dir}/`))) return true;
      if (above.includes(form)) return true;
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

/** Longest inline code judged; longer code fails closed. */
const MAX_CODE = 100_000;

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
  const changes =
    /unlink|remove|rmtree|rmdir|\brm\b|rmSync|rename|truncate|writeFile|open\s*\(|shutil|glob|listdir|walk|readdir|system|exec|spawn|subprocess/i.test(
      code,
    );
  if (!changes) return false;
  // The temp directory computed at run time (case matters: `/tmp` in a path is not `TMP`).
  if (
    /\$\{?(?:TMPDIR|TMP|TEMP)\b|environ\b[^\n]{0,40}\b(?:TMPDIR|TMP|TEMP)\b|process\.env\.(?:TMPDIR|TMP|TEMP)\b|ENV\[\s*["'](?:TMPDIR|TMP|TEMP)|getenv\(\s*["'](?:TMPDIR|TMP|TEMP)|gettempdir|tempfile\.tempdir|os\.tmpdir|tmpdir\(\)|Dir\.tmpdir|sys_get_temp_dir|GetTempPath/.test(
      code,
    )
  )
    return true;
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
