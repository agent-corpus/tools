import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonical, git } from "./evidence.js";
import { SHELL_TOOLS } from "./policy.js";
import { parseShell } from "./shell.js";
import { command as commandOf, scan, type Word } from "./shellscan.js";
import type { Request } from "./types.js";

/**
 * The user's own permission rules in each harness, read (never written) so the policy manager
 * agrees with them: a user deny or ask rule beats any approval here (no hook decision, so the
 * harness's own flow applies), and a user allow rule counts as the person's answer.
 */
export type NativeVerdict = "allow" | "ask" | "deny";
export interface NativeMatch {
  verdict: NativeVerdict;
  /** The rule that decided it, as the user wrote it. */
  rule: string;
  /** The file it came from. */
  source: string;
}

const MAX_FILE = 1024 * 1024;
const cache = new Map<string, { key: string; value: unknown }>();
/** A small file the user owns, read again only when it changes. Undefined when missing or unsafe. */
function readCached<T>(path: string, parse: (text: string) => T): T | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE) return undefined;
    const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    const hit = cache.get(path);
    if (hit?.key === key) return hit.value as T;
    const value = parse(readFileSync(path, "utf8"));
    if (cache.size > 256) cache.clear();
    cache.set(path, { key, value });
    return value;
  } catch {
    return undefined;
  }
}

function topLevel(cwd: string): string | undefined {
  try {
    return cwd && existsSync(cwd)
      ? canonical(git(cwd, ["rev-parse", "--show-toplevel"]))
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Pattern matching shared by the readers. Both matchers are iterative with no regular
// expressions built from user text, so a rule or a command cannot make matching super-linear.

/** `*` matches any run of characters, including none and spaces. O(text × pattern) worst case. */
export function wildcard(pattern: string, text: string): boolean {
  let p = 0,
    t = 0,
    star = -1,
    mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Gitignore-style path glob over `/` segments: `**` any segments, `*` and `?` within one. */
export function pathGlob(pattern: string, path: string): boolean {
  const ps = pattern.split("/").filter((part, i) => part !== "" || i === 0);
  const ts = path.split("/").filter((part, i) => part !== "" || i === 0);
  const segment = (p: string, t: string) =>
    !p.includes("?")
      ? wildcard(p, t)
      : p.length === t.length && [...p].every((c, i) => c === "?" || c === t[i]);
  // Iterative `**` matching, the same backtracking shape as `wildcard`.
  let p = 0,
    t = 0,
    star = -1,
    mark = 0;
  while (t < ts.length) {
    if (p < ps.length && ps[p] !== "**" && segment(ps[p] as string, ts[t] as string)) {
      p++;
      t++;
    } else if (p < ps.length && ps[p] === "**") {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (ps[p] === "**") p++;
  return p === ps.length;
}

// ---------------------------------------------------------------------------------------------
// Claude Code: `permissions.allow|ask|deny` in settings files.
// https://code.claude.com/docs/en/permissions

interface ClaudeRules {
  allow: string[];
  ask: string[];
  deny: string[];
}
interface ClaudeFile {
  path: string;
  rules: ClaudeRules;
  /** Where `/path` rules are relative to. */
  base: string;
  /** Allow rules count only from the user's own and managed settings, never from a checkout. */
  allows: boolean;
}

/** Claude Code's managed settings file for this platform. */
function managedSettings(): string {
  if (process.platform === "darwin")
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32")
    return join(
      process.env.ProgramData ?? "C:\\ProgramData",
      "ClaudeCode",
      "managed-settings.json",
    );
  return "/etc/claude-code/managed-settings.json";
}

function claudeRules(text: string): ClaudeRules {
  const value = JSON.parse(text) as { permissions?: Record<string, unknown> };
  const list = (key: string) => {
    const entries = value?.permissions?.[key];
    return Array.isArray(entries)
      ? entries.filter(
          (entry): entry is string => typeof entry === "string" && entry.length <= 1000,
        )
      : [];
  };
  return { allow: list("allow"), ask: list("ask"), deny: list("deny") };
}

/**
 * The user settings (`CLAUDE_CONFIG_DIR`, else `~/.claude`) and the project's `.claude/settings.json`
 * and `.claude/settings.local.json`, for the project the hook reports (`CLAUDE_PROJECT_DIR`) and
 * the checkout the request runs in.
 */
function claudeFiles(request: Request): ClaudeFile[] {
  const user = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const projects = new Set<string>();
  if (process.env.CLAUDE_PROJECT_DIR && isAbsolute(process.env.CLAUDE_PROJECT_DIR))
    projects.add(resolve(process.env.CLAUDE_PROJECT_DIR));
  const top = topLevel(request.cwd);
  if (top) projects.add(top);
  else if (request.cwd && isAbsolute(request.cwd)) projects.add(resolve(request.cwd));
  const files: ClaudeFile[] = [];
  const add = (path: string, base: string, allows: boolean) => {
    const rules = readCached(path, claudeRules);
    if (rules) files.push({ path, rules, base, allows });
  };
  const first = [...projects][0] ?? request.cwd;
  add(managedSettings(), first, true);
  add(join(user, "settings.json"), first, true);
  // A checkout's settings can only make a request stricter: their deny and ask rules count, their
  // allow rules do not (the checkout can be anyone's branch).
  for (const project of projects) {
    add(join(project, ".claude", "settings.json"), project, false);
    add(join(project, ".claude", "settings.local.json"), project, false);
  }
  return files;
}

/** `Tool` or `Tool(content)`. */
function parseRule(rule: string): { tool: string; content?: string } | undefined {
  const open = rule.indexOf("(");
  if (open < 0) return /^[\w.*-]+$/.test(rule) ? { tool: rule } : undefined;
  if (!rule.endsWith(")")) return undefined;
  return { tool: rule.slice(0, open), content: rule.slice(open + 1, -1) };
}

/**
 * Process wrappers Claude Code strips before matching: `timeout`, `time`, `nice`, `nohup`,
 * `stdbuf`, `command`, `builtin`, `noglob`, and bare `xargs`.
 */
function stripWrappers(words: string[]): string[] {
  let rest = words;
  for (let guard = 0; guard < 8 && rest.length; guard++) {
    const [head = "", ...tail] = rest;
    if (["time", "nohup", "command", "builtin", "noglob"].includes(head)) {
      rest = head === "time" && tail[0] === "-p" ? tail.slice(1) : tail;
    } else if (head === "nice") {
      rest = tail[0] === "-n" ? tail.slice(2) : /^-\d+$/.test(tail[0] ?? "") ? tail.slice(1) : tail;
    } else if (head === "timeout") {
      let i = 0;
      while (tail[i]?.startsWith("-"))
        i += ["-s", "--signal", "-k", "--kill-after"].includes(tail[i] as string) ? 2 : 1;
      rest = tail.slice(i + 1);
    } else if (head === "stdbuf") {
      let i = 0;
      while (tail[i]?.startsWith("-")) i += /^-[ioe]$/.test(tail[i] as string) ? 2 : 1;
      rest = tail.slice(i);
    } else if (head === "xargs" && tail.length && !tail[0]?.startsWith("-")) rest = tail;
    else break;
  }
  return rest;
}

/** Programs that always prompt in Claude Code, whatever a prefix rule says. */
function alwaysPrompts(words: string[]): boolean {
  const [program = "", ...args] = words;
  if (["watch", "setsid", "ionice", "flock"].includes(program)) return true;
  return (
    program === "find" &&
    args.some((arg) =>
      ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fls"].includes(arg),
    )
  );
}

/**
 * One Bash rule against one subcommand's text. Without `*` the rule is the exact command.
 * `cmd:*` is the same as `cmd *`; a rule whose only `*` is a trailing ` *` also matches the bare
 * command (`Bash(ls *)` matches `ls`, not `lsof`). Otherwise `*` matches any text, spaces too.
 */
export function bashRuleMatches(content: string, text: string): boolean {
  let pattern = content.trim();
  if (pattern === "" || pattern === "*") return true;
  if (pattern.endsWith(":*")) pattern = `${pattern.slice(0, -2)} *`;
  const stars = pattern.split("*").length - 1;
  if (stars === 0) return pattern === text;
  if (stars === 1 && pattern.endsWith(" *")) {
    const prefix = pattern.slice(0, -2);
    return text === prefix || text.startsWith(`${prefix} `);
  }
  return wildcard(pattern, text);
}

interface Subcommand {
  /**
   * For deny and ask: the words after every wrapper the hard-rule scanner knows (`sudo`, `env`,
   * `exec`...) and assignments are stripped, so a deny reaches the inner command.
   */
  text: string;
  /**
   * For allow: the words as written, with only Claude Code's documented wrappers stripped. `sudo`,
   * `env`, `exec` and the like stay the program, so `Bash(git status:*)` does not allow
   * `sudo git status`.
   */
  allowText: string;
  /** Leading assignments were present. */
  assigned: boolean;
  /** Every word is literal and every redirect harmless, so an allow rule may cover it. */
  plain: boolean;
  prompts: boolean;
}

function subcommands(script: string): { parts: Subcommand[]; complete: boolean } {
  const { segments, complete } = scan(script);
  const parts: Subcommand[] = [];
  for (const segment of segments) {
    const cmd = commandOf(segment);
    if (!cmd.program) continue;
    const words = [cmd.program, ...cmd.args];
    const stripped = stripWrappers(words.map((word) => word.text));
    const raw = segment.filter((word) => !word.redirect);
    const written = stripWrappers(raw.map((word) => word.text));
    const harmless = (word: Word) =>
      word.literal && (word.text === "/dev/null" || /^\d$/.test(word.text));
    parts.push({
      text: stripped.join(" "),
      allowText: written.join(" "),
      assigned: cmd.assignments.length > 0,
      plain: raw.every((word) => word.literal) && cmd.redirects.every(harmless),
      prompts: alwaysPrompts(written) || alwaysPrompts(stripped),
    });
  }
  return { parts, complete };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** A Read or Edit path rule as an absolute glob, per the documented prefixes. */
function pathPattern(content: string, cwd: string, base: string): string {
  if (content.startsWith("//")) return content.slice(1);
  if (content.startsWith("~/"))
    return join(homedir(), content.slice(2))
      .replace(/\\/g, "/")
      .replace(/^[A-Za-z]:(?=\/)/, "");
  if (content.startsWith("/")) return `${base.replace(/\\/g, "/")}${content}`;
  const relative = content.startsWith("./") ? content.slice(2) : content;
  // Gitignore style: a pattern with no `/` matches at any depth (`Read(.env)` is `Read(**/.env)`).
  const anywhere = !relative.includes("/");
  return `${cwd.replace(/\\/g, "/")}/${anywhere ? "**/" : ""}${relative}`;
}

function claudeRuleMatches(rule: string, request: Request, base: string): boolean {
  const parsed = parseRule(rule.trim());
  if (!parsed) return false;
  const { tool, content } = parsed;
  if (tool.startsWith("mcp__")) {
    if (!request.tool.startsWith("mcp__")) return false;
    if (content !== undefined) return false;
    return (
      request.tool === tool ||
      request.tool.startsWith(`${tool}__`) ||
      (tool.endsWith("*") && wildcard(tool, request.tool))
    );
  }
  if (tool === "Bash") {
    if (!SHELL_TOOLS.has(request.tool)) return false;
    const script = request.input.command;
    if (typeof script !== "string") return false;
    if (content === undefined || content.trim() === "*") return true;
    const { parts } = subcommands(script);
    // Deny and ask rules apply to any subcommand, past any leading assignment. (Allow rules for
    // shell commands are matched per subcommand in `allowedScript`.)
    return (
      parts.some(
        (part) => bashRuleMatches(content, part.text) || bashRuleMatches(content, part.allowText),
      ) || bashRuleMatches(content, script.trim())
    );
  }
  const edit = tool === "Edit" && EDIT_TOOLS.has(request.tool);
  const read = tool === "Read" && request.tool === "Read";
  const same = tool === request.tool && !SHELL_TOOLS.has(tool);
  if (!edit && !read && !same) return false;
  if (content === undefined || content === "" || content === "*" || content === "**") return true;
  if (!edit && !read) return false;
  const file = request.input.file_path ?? request.input.notebook_path ?? request.input.path;
  if (typeof file !== "string" || !request.cwd) return false;
  const windows = process.platform === "win32";
  // Every spelling of a path: as written and resolved (Windows 8.3 short names and symlinks
  // expanded), with `/` separators, lower-cased on Windows, and without its drive letter so that
  // a `//abs` rule (written from the filesystem root) matches `C:/abs`.
  const spellings = (path: string): string[] => {
    const forms = new Set([path]);
    try {
      forms.add(realpathSync.native(path));
    } catch {
      try {
        forms.add(join(realpathSync.native(dirname(path)), basename(path)));
      } catch {
        /* missing: as written */
      }
    }
    const out = new Set<string>();
    for (const form of forms) {
      const slashed = form.replace(/\\/g, "/");
      const cased = windows ? slashed.toLowerCase() : slashed;
      out.add(cased);
      if (windows) out.add(cased.replace(/^[a-z]:(?=\/)/, ""));
    }
    return [...out];
  };
  const targets = spellings(resolve(request.cwd, file));
  for (const cwd of spellings(request.cwd))
    for (const root of spellings(base)) {
      const pattern = pathPattern(content, cwd, root);
      const patterns = [pattern, `${pattern}/**`].map((p) => (windows ? p.toLowerCase() : p));
      if (targets.some((target) => patterns.some((p) => pathGlob(p, target)))) return true;
    }
  return false;
}

/** Allow rules covering every subcommand of a script, each part by any allow rule. */
function allowedScript(script: string, files: ClaudeFile[]): NativeMatch | undefined {
  const { parts, complete } = subcommands(script);
  if (!complete || !parts.length || /(?:&&|\|\||\|)\s*$/.test(script.trim())) return undefined;
  const used: NativeMatch[] = [];
  for (const part of parts) {
    if (!part.plain || part.assigned || part.prompts) return undefined;
    let found: NativeMatch | undefined;
    for (const file of files) {
      for (const rule of file.allows ? file.rules.allow : []) {
        const parsed = parseRule(rule.trim());
        if (parsed?.tool !== "Bash") continue;
        if (parsed.content === undefined || bashRuleMatches(parsed.content, part.allowText)) {
          found = { verdict: "allow", rule, source: file.path };
          break;
        }
      }
      if (found) break;
    }
    if (!found) return undefined;
    if (!used.some((match) => match.rule === found.rule)) used.push(found);
  }
  return {
    verdict: "allow",
    rule: used.map((match) => match.rule).join(", "),
    source: [...new Set(used.map((match) => match.source))].join(", "),
  };
}

/**
 * Claude Code's evaluation: deny, then ask, then allow; the first match decides. A compound
 * command is allowed when every subcommand is covered by some allow rule.
 */
function claudeVerdict(request: Request): NativeMatch | undefined {
  const files = claudeFiles(request);
  for (const verdict of ["deny", "ask"] as const)
    for (const file of files)
      for (const rule of file.rules[verdict])
        if (claudeRuleMatches(rule, request, file.base))
          return { verdict, rule, source: file.path };
  const script = request.input.command;
  if (SHELL_TOOLS.has(request.tool) && typeof script === "string") {
    // `Bash` or `Bash(*)` allows everything; otherwise every part needs a rule.
    for (const file of files)
      for (const rule of file.allows ? file.rules.allow : [])
        if (/^Bash(?:\(\s*\*?\s*\))?$/.test(rule.trim()))
          return { verdict: "allow", rule, source: file.path };
    return allowedScript(script, files);
  }
  for (const file of files)
    for (const rule of file.allows ? file.rules.allow : [])
      if (claudeRuleMatches(rule, request, file.base))
        return { verdict: "allow", rule, source: file.path };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Codex: execpolicy `.rules` files with `prefix_rule(...)`.
// https://developers.openai.com/codex/rules (https://learn.chatgpt.com/docs/agent-configuration/rules)
// `~/.codex/rules/` (CODEX_HOME) always; `<project>/.codex/rules/` only when the project is
// trusted in config.toml (`[projects."<path>"] trust_level = "trusted"`).
// https://developers.openai.com/codex/config-reference

type CodexDecision = "allow" | "prompt" | "forbidden";
interface PrefixRule {
  pattern: string[][];
  decision: CodexDecision;
  text: string;
}

type Value = string | Value[];

/** Parses the `prefix_rule(...)` calls of a rules file. Other statements are skipped. */
export function parseCodexRules(text: string): PrefixRule[] {
  const rules: PrefixRule[] = [];
  let i = 0;
  const space = () => {
    while (i < text.length) {
      if (/\s/.test(text[i] as string)) i++;
      else if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
      else break;
    }
  };
  const string = (): string => {
    const quote = text[i] as string;
    const triple = text.startsWith(quote.repeat(3), i);
    i += triple ? 3 : 1;
    let out = "";
    while (i < text.length) {
      if (triple ? text.startsWith(quote.repeat(3), i) : text[i] === quote) {
        i += triple ? 3 : 1;
        return out;
      }
      if (text[i] === "\\" && i + 1 < text.length) {
        const next = text[i + 1] as string;
        out += { n: "\n", t: "\t" }[next] ?? next;
        i += 2;
      } else out += text[i++];
    }
    throw new Error("Unterminated string");
  };
  const value = (depth = 0): Value => {
    space();
    const c = text[i];
    if (c === '"' || c === "'") return string();
    if (c === "[" && depth < 4) {
      i++;
      const items: Value[] = [];
      for (;;) {
        space();
        if (text[i] === "]") {
          i++;
          return items;
        }
        items.push(value(depth + 1));
        space();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") throw new Error("Bad list");
      }
    }
    throw new Error("Unsupported value");
  };
  const skipCall = () => {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'") {
        string();
        continue;
      }
      if (c === "(") depth++;
      if (c === ")" && --depth === 0) {
        i++;
        return;
      }
      i++;
    }
  };
  while (i < text.length) {
    space();
    const start = i;
    const name = /^[A-Za-z_]\w*/.exec(text.slice(i, i + 64))?.[0];
    if (!name) {
      i++;
      continue;
    }
    i += name.length;
    space();
    if (text[i] !== "(") continue;
    if (name !== "prefix_rule") {
      skipCall();
      continue;
    }
    i++;
    const args: Record<string, Value> = {};
    try {
      for (;;) {
        space();
        if (text[i] === ")") {
          i++;
          break;
        }
        const key = /^[A-Za-z_]\w*/.exec(text.slice(i, i + 64))?.[0];
        if (!key) throw new Error("Expected a keyword argument");
        i += key.length;
        space();
        if (text[i] !== "=") throw new Error("Expected =");
        i++;
        args[key] = value();
        space();
        if (text[i] === ",") i++;
      }
    } catch {
      // An unreadable rule is skipped: it can neither allow nor stop anything here.
      i = start;
      i += name.length;
      skipCall();
      continue;
    }
    const pattern = args.pattern;
    const decision = (args.decision ?? "allow") as Value;
    if (
      !Array.isArray(pattern) ||
      !pattern.length ||
      !["allow", "prompt", "forbidden"].includes(decision as string)
    )
      continue;
    const elements = pattern.map((element) =>
      typeof element === "string"
        ? [element]
        : Array.isArray(element) && element.every((e) => typeof e === "string")
          ? (element as string[])
          : undefined,
    );
    if (elements.some((element) => !element?.length)) continue;
    rules.push({
      pattern: elements as string[][],
      decision: decision as CodexDecision,
      text: text.slice(start, i).replace(/\s+/g, " ").slice(0, 300),
    });
  }
  return rules;
}

function codexFiles(
  request: Request,
): Array<{ path: string; rules: PrefixRule[]; allows: boolean }> {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  // Allow rules count only from CODEX_HOME. A checkout's `.codex/rules` can only make a request
  // stricter: its prompt and forbidden rules count, trusted or not, and its allow rules do not.
  const dirs: Array<[string, boolean]> = [[join(home, "rules"), true]];
  const top = topLevel(request.cwd);
  if (top) dirs.push([join(top, ".codex", "rules"), false]);
  const files: Array<{ path: string; rules: PrefixRule[]; allows: boolean }> = [];
  for (const [dir, allows] of dirs) {
    let names: string[];
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      names = readdirSync(dir)
        .filter((name) => name.endsWith(".rules"))
        .sort();
    } catch {
      continue;
    }
    for (const name of names.slice(0, 64)) {
      const path = join(dir, name);
      const rules = readCached(path, parseCodexRules);
      if (rules) files.push({ path, rules, allows });
    }
  }
  return files;
}

/**
 * The invocations Codex evaluates for a shell script: each command of a linear chain of plain
 * words joined by `&&`, `||`, `;` or `|`; anything else (redirects, substitutions, assignments,
 * globs, control flow) is one `bash -lc <script>` invocation.
 */
export function codexInvocations(script: string): string[][] {
  const pipelines = parseShell(script);
  const plain =
    pipelines?.every((pipeline) =>
      pipeline.every(
        (cmd) =>
          !cmd.env.length &&
          !cmd.redirects.length &&
          !cmd.subs.length &&
          cmd.stdin === undefined &&
          !cmd.loose?.some(Boolean) &&
          !cmd.glob?.some(Boolean),
      ),
    ) ?? false;
  if (pipelines && plain) return pipelines.flatMap((pipeline) => pipeline.map((cmd) => cmd.argv));
  return [["bash", "-lc", script]];
}

const STRICTNESS: Record<CodexDecision, number> = { allow: 0, prompt: 1, forbidden: 2 };

function codexVerdict(request: Request): NativeMatch | undefined {
  const script = request.input.command ?? request.input.cmd;
  if (!SHELL_TOOLS.has(request.tool) || typeof script !== "string") return undefined;
  const files = codexFiles(request);
  if (!files.length) return undefined;
  const invocations = Array.isArray(request.input.command)
    ? [request.input.command as string[]]
    : codexInvocations(script);
  let worst: (NativeMatch & { level: number }) | undefined;
  let covered = 0;
  for (const argv of invocations) {
    let best: (NativeMatch & { level: number }) | undefined;
    for (const file of files)
      for (const rule of file.rules) {
        if (rule.decision === "allow" && !file.allows) continue;
        if (rule.pattern.length > argv.length) continue;
        if (!rule.pattern.every((options, k) => options.includes(argv[k] as string))) continue;
        // When several rules match, the most restrictive decision applies.
        const level = STRICTNESS[rule.decision];
        if (!best || level > best.level)
          best = {
            verdict:
              rule.decision === "allow" ? "allow" : rule.decision === "prompt" ? "ask" : "deny",
            rule: rule.text,
            source: file.path,
            level,
          };
      }
    if (best) {
      covered++;
      if (!worst || best.level > worst.level) worst = best;
    }
  }
  if (!worst) return undefined;
  // An allow needs every invocation allowed; a prompt or forbidden on any one applies.
  if (worst.verdict === "allow" && covered < invocations.length) return undefined;
  const { level: _level, ...match } = worst;
  return match;
}

// ---------------------------------------------------------------------------------------------
// Copilot CLI: its documented allow and deny lists are the `--allow-tool`/`--deny-tool` flags,
// which "apply only to the current session and aren't written to permissions-config.json";
// the format of the saved per-location approvals is not documented, and trusted folders gate
// file access, not commands. There is no documented file to read, so nothing is matched.
// https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools

/** The user's own rule verdict for a request in its harness, or undefined when none applies. */
export function nativeRules(request: Request): NativeMatch | undefined {
  try {
    if (request.harness === "claude") return claudeVerdict(request);
    if (request.harness === "codex") return codexVerdict(request);
    return undefined;
  } catch {
    return undefined;
  }
}

/** For tests: forget cached rule files. */
export function clearNativeRuleCache(): void {
  cache.clear();
}
