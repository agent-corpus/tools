import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import { canonical, type Fill, resolveWord, UNKNOWN_CWD } from "./evidence.js";
import { BANNED_ENV, human, redirectDecision, simpleDecision, unwrap } from "./permissive.js";
import { result } from "./policy.js";
import type { Profile } from "./profile.js";
import {
  applyParamOp,
  type Command,
  type FunctionNode,
  type ListNode,
  type PipelineNode,
  parseScript,
  type Redir,
  type Simple,
  SUBSTITUTION,
  type Word,
} from "./script.js";
import type { Redirect, SimpleCommand } from "./shell.js";
import type { Decision, Request } from "./types.js";

/**
 * Walks a parsed script and judges every command that could run. The state carried along is the
 * set of directories the next command could run in and the variables whose value is known. A
 * variable with a known, simple value is replaced by it and the real command is judged; anything
 * else is an unknown value, which `simpleDecision` confines to arguments that cannot change what a
 * command does. Branches are judged on copies and merged conservatively; anything a loop assigns
 * is unknown inside it and afterwards.
 */

const MAX_DIRECTORIES = 8;
const MAX_VARIANTS = 16;
const MAX_SUBSTITUTION_DEPTH = 3;
/** Commands one script may be judged as; past this it is too large to verify in time. */
const MAX_JUDGEMENTS = 400;
/** No whitespace, glob, quote, expansion or tilde characters: the value is exactly one word. */
const SIMPLE_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSUPPORTED = "Unsupported shell syntax; expansions and subshells need human review";
const MAX_CALL_DEPTH = 4;
/** Positional parameters: never from the environment, unknown unless `set --` or a call set them. */
const POSITIONAL = /^(?:[0-9]+|[@*])$/;
/** Prefix of an entry in an assigned-name set that stands for a function definition. */
const FUNCTION_MARK = "()";

interface State {
  cwds: string[];
  /**
   * Set by `cd`: the directories the shell is still in if that `cd` failed. A following `&&` only
   * runs after it succeeded, so it drops these; anything else may run after a failure, so it
   * adds them back (`settle`).
   */
  failed?: string[];
  /**
   * Variables the script assigned: their known values, or null when the value is unknown (it came
   * from a command, a glob or a loop). A name that is absent was never assigned here, so it is an
   * environment variable of unknown content.
   */
  vars: Map<string, string[] | null>;
  /** Functions the script defined; null when it may or may not be defined, or defined differently. */
  funcs: Map<string, FunctionNode | null>;
}
interface Ctx {
  request: Request;
  profile: Profile;
  depth: number;
  loop: number;
  /** Function calls in progress. */
  calls: number;
  /** False when the script could assign positional parameters through zsh's `argv` array. */
  positional: boolean;
  /** Inside a background job, or a script run where later commands can overtake it. */
  reorder?: boolean;
  /** `first` is the script's first top-level pipeline, the only `cd` trusted not to fail. */
  box: {
    last?: Decision;
    calls: number;
    first?: PipelineNode;
    /** Directories that earlier commands create, so a later `cd` into one is not unknown. */
    created?: Set<string>;
    /** Whether a symlink may exist that the hook could not see (see `Fill`). */
    script: Fill["script"];
  };
}

const copy = (state: State): State => ({
  cwds: [...state.cwds],
  ...(state.failed ? { failed: [...state.failed] } : {}),
  vars: new Map(state.vars),
  funcs: new Map(state.funcs),
});

/** The last `cd` may have failed: every directory it could have left the shell in is possible. */
function settle(state: State): void {
  if (state.failed) state.cwds = [...new Set([...state.cwds, ...state.failed])];
  delete state.failed;
}

/** Every directory either state could be in; neither input is changed. */
function merge(a: State, b: State): State {
  const cwds = [...a.cwds, ...(a.failed ?? []), ...b.cwds, ...(b.failed ?? [])];
  const vars = new Map<string, string[] | null>();
  for (const [name, left] of a.vars) {
    if (!b.vars.has(name)) continue; // assigned on one path only: an environment value is possible
    const right = b.vars.get(name);
    const union = left && right ? [...new Set([...left, ...right])] : null;
    vars.set(name, union && union.length <= MAX_VARIANTS ? union : null);
  }
  const funcs = new Map<string, FunctionNode | null>();
  for (const name of new Set([...a.funcs.keys(), ...b.funcs.keys()])) {
    const left = a.funcs.get(name);
    funcs.set(name, left && left === b.funcs.get(name) ? left : null);
  }
  return { cwds: [...new Set(cwds)], vars, funcs };
}

function replace(target: State, source: State): void {
  target.cwds = source.cwds;
  if (source.failed) target.failed = source.failed;
  else delete target.failed;
  target.vars = source.vars;
  target.funcs = source.funcs;
}

// --- words ------------------------------------------------------------------------------------

const isKnown = (values: string[] | null | undefined): values is string[] =>
  !!values?.length && values.every((v) => SIMPLE_VALUE.test(v));

/**
 * Environment variables whose value is harmless to print or pass on. Any other variable the script
 * did not assign could hold a credential (`$GITHUB_TOKEN`, `$AWS_SECRET_ACCESS_KEY`), so using it
 * needs a human; its value is never known, so it is also an unknown marker.
 */
const ENVIRONMENT_OK = new Set([
  "PWD",
  "OLDPWD",
  "USER",
  "LOGNAME",
  "HOSTNAME",
  "LANG",
  "TERM",
  "TMPDIR",
  "SHLVL",
  "CI",
  "NODE_ENV",
  "TZ",
  "LC_ALL",
  "COLUMNS",
  "LINES",
]);

/**
 * Programs whose output depends only on their literal arguments (and the directory), so a
 * substitution of one can be computed: `$(dirname /a/b)` is `/a`. A function of the same name
 * replaces the program, so a defined one makes the output unknown again.
 */
const PURE = new Set(["dirname", "basename", "pwd"]);
const pureCache = new Map<string, Simple | null>();

/** The single `dirname x`, `basename x [suffix]` or `pwd` command a substitution runs, if it is. */
function pureCommand(inner: string): Simple | undefined {
  let cached = pureCache.get(inner);
  if (cached === undefined) {
    const script = parseScript(inner);
    const item = script?.items.length === 1 ? script.items[0] : undefined;
    const node = item && !item.background && !item.node.rest.length ? item.node.first : undefined;
    const stage = node && !node.negated && node.stages.length === 1 ? node.stages[0] : undefined;
    const name = stage?.kind === "simple" ? plainText(stage.argv[0]) : undefined;
    cached =
      stage?.kind === "simple" &&
      name !== undefined &&
      PURE.has(name) &&
      !stage.assigns.length &&
      !stage.redirects.length &&
      stage.argv.every((w) => !w.subs.length && !w.glob)
        ? stage
        : null;
    if (pureCache.size > 256) pureCache.clear();
    pureCache.set(inner, cached);
  }
  return cached ?? undefined;
}

function wordNames(word: Word, out: Set<string>): void {
  for (const part of word.parts)
    if (typeof part === "object" && "name" in part) out.add(part.name);
    else if (typeof part === "object" && part.inner !== undefined) {
      const pure = pureCommand(part.inner);
      if (pure) for (const w of pure.argv) wordNames(w, out);
    }
}

function environmentRefs(ctx: Ctx, words: Word[], state: State): Decision | undefined {
  const names = new Set<string>();
  for (const word of words) wordNames(word, names);
  for (const name of names)
    if (!state.vars.has(name) && !ENVIRONMENT_OK.has(name) && !POSITIONAL.test(name))
      return human(
        ctx.request,
        "unknown",
        "An environment variable of unknown content requires human review",
      );
  return undefined;
}

function knownVariables(words: Word[], state: State): Map<string, string[]> {
  const names = new Set<string>();
  for (const word of words) wordNames(word, names);
  const known = [...names].filter((name) => isKnown(state.vars.get(name)));
  const size = (list: string[]) => list.reduce((n, k) => n * (state.vars.get(k)?.length ?? 1), 1);
  known.sort((a, b) => (state.vars.get(b)?.length ?? 0) - (state.vars.get(a)?.length ?? 0));
  while (known.length && size(known) > MAX_VARIANTS) known.shift();
  return new Map(known.map((name) => [name, state.vars.get(name) as string[]]));
}

function combinations(known: Map<string, string[]>): Array<Record<string, string>> {
  let out: Array<Record<string, string>> = [{}];
  for (const [name, values] of known)
    out = out.flatMap((env) => values.map((value) => ({ ...env, [name]: value })));
  return out;
}

/** Output of a pure substitution for one choice of values, or undefined when it is unknown. */
function pureOutput(
  inner: string,
  known: Map<string, string[]>,
  env: Record<string, string>,
  state: State,
): string | undefined {
  const command = pureCommand(inner);
  const name = command ? plainText(command.argv[0]) : undefined;
  if (!command || name === undefined || state.funcs.has(name)) return undefined;
  const args: string[] = [];
  for (const word of command.argv.slice(1)) {
    const { text } = instantiate(word, known, env, state);
    if (!SIMPLE_VALUE.test(text) || text.startsWith("-")) return undefined;
    args.push(text);
  }
  let output: string | undefined;
  if (name === "pwd") output = args.length === 0 && state.cwds.length === 1 ? state.cwds[0] : "";
  else if (name === "dirname" && args.length === 1) output = posix.dirname(args[0] as string);
  else if (name === "basename" && (args.length === 1 || args.length === 2)) {
    const [path, suffix] = args as [string, string | undefined];
    const base = posix.basename(path);
    output =
      suffix && base !== suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
  }
  return output && SIMPLE_VALUE.test(output) ? output : undefined;
}

/** Text of a word for one choice of variable values; unknown parts become SUBSTITUTION. */
function instantiate(
  word: Word,
  known: Map<string, string[]>,
  env: Record<string, string>,
  state?: State,
): { text: string; loose: boolean } {
  let text = "";
  let loose = false;
  for (const part of word.parts) {
    if (typeof part === "string") text += part;
    else if ("unknown" in part) {
      const output =
        state && part.inner !== undefined ? pureOutput(part.inner, known, env, state) : undefined;
      if (output !== undefined) text += output;
      else {
        text += SUBSTITUTION;
        loose ||= !part.quoted;
      }
    } else if (known.has(part.name)) text += applyParamOp(env[part.name] ?? "", part.op);
    else {
      text += SUBSTITUTION;
      // "$@" is one word per parameter even when quoted.
      loose ||= !part.quoted || part.name === "@";
    }
  }
  return { text, loose };
}

function plainText(word: Word | undefined): string | undefined {
  if (!word) return undefined;
  let text = "";
  for (const part of word.parts) {
    if (typeof part !== "string") return undefined;
    text += part;
  }
  return text;
}

// --- substitutions and redirections -----------------------------------------------------------

/** Judges the commands inside `$(...)`, backticks and `<(...)`; they run before their command. */
function runSubs(ctx: Ctx, subs: string[], state: State): Decision | undefined {
  for (const inner of subs) {
    if (ctx.depth >= MAX_SUBSTITUTION_DEPTH)
      return human(ctx.request, "unknown", "Command substitutions are nested too deeply");
    const script = parseScript(inner);
    if (!script) return human(ctx.request, "unknown", UNSUPPORTED);
    const refusal = runList({ ...ctx, depth: ctx.depth + 1, loop: 0 }, script, copy(state));
    if (refusal) return refusal;
  }
  return undefined;
}

function toRedirect(redir: Redir, text: string): Redirect | undefined {
  if (redir.op === "<<" || redir.op === "<<<") return undefined;
  return { fd: redir.fd, op: redir.op, target: text };
}

/** Redirections attached to a compound command. */
function runRedirects(ctx: Ctx, redirs: Redir[], state: State): Decision | undefined {
  const words = redirs.flatMap((r) => (r.target ? [r.target] : []));
  const refusal = runSubs(
    ctx,
    words.flatMap((w) => w.subs),
    state,
  );
  if (refusal) return refusal;
  const unsafe = environmentRefs(ctx, words, state);
  if (unsafe) return unsafe;
  const known = knownVariables(words, state);
  for (const env of combinations(known))
    for (const redir of redirs) {
      if (!redir.target) continue;
      const redirect = toRedirect(redir, instantiate(redir.target, known, env, state).text);
      if (!redirect) continue;
      for (const cwd of state.cwds) {
        const check = redirectDecision(
          ctx.request,
          redirect,
          ctx.profile,
          cwd,
          fillFor(ctx, false),
        );
        if (check) return check;
      }
    }
  return undefined;
}

// --- assigned names ---------------------------------------------------------------------------

/**
 * Special builtins keep a prefix assignment in the shell afterwards when it runs as sh, dash or
 * bash in POSIX mode (and zsh with posixbuiltins), so `X=rm :` assigns X.
 */
const SPECIAL_BUILTINS = new Set([
  ":",
  ".",
  "eval",
  "exec",
  "exit",
  "export",
  "readonly",
  "return",
  "set",
  "shift",
  "times",
  "trap",
  "unset",
  "break",
  "continue",
]);

/**
 * The variable `printf -v` or zsh `print -v` stores into: `-v NAME` or `-vNAME`. A cluster that
 * contains `v` in any other form (`-rv`, `-vr`), or a computed option or name, is unreadable.
 */
function printTargets(args: Array<string | undefined>): { names: string[]; unreadable: boolean } {
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) return { names, unreadable: true };
    if (arg === "--" || !arg.startsWith("-") || arg === "-") break;
    if (!arg.includes("v")) continue;
    const next = args[i + 1];
    if (arg === "-v") {
      if (next && NAME.test(next)) {
        names.push(next);
        i++;
      } else return { names, unreadable: true };
    } else if (/^-v[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
      // `-vNAME`, or a cluster whose last option takes the next word: both are possible targets.
      names.push(arg.slice(2));
      if (next && NAME.test(next)) names.push(next);
    } else return { names, unreadable: true };
  }
  return { names, unreadable: false };
}

type Funcs = Map<string, FunctionNode | null>;
/** `$@` and `$*` are never stored, so they stay unknown (and `*` is the forget-everything mark). */
const POSITIONAL_NAMES = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

function assignedInSimple(node: Simple, out: Set<string>, funcs?: Funcs, seen?: Set<string>): void {
  if (!node.argv.length) {
    for (const a of node.assigns) out.add(a.name);
    return;
  }
  const literal = plainText(node.argv[0]);
  const fn = literal === undefined ? undefined : funcs?.get(literal);
  if (literal !== undefined && fn && !seen?.has(literal)) {
    // A call runs the body in this shell, so what the body assigns is assigned here.
    const visited = new Set([...(seen ?? []), literal]);
    assignedInList(fn.body.body, out, funcs, visited);
  } else if (literal !== undefined && fn === null) out.add("*");
  const name = basename(literal ?? "");
  const args = node.argv.slice(1).map(plainText);
  if (name === "set" || name === "shift") for (const p of POSITIONAL_NAMES) out.add(p);
  if (SPECIAL_BUILTINS.has(name)) for (const a of node.assigns) out.add(a.name);
  if (name === "export")
    for (const arg of args) {
      const head = arg?.split("=")[0];
      if (head && NAME.test(head)) out.add(head);
    }
  else if (name === "unset" || name === "read")
    for (const arg of args) {
      if (arg && NAME.test(arg)) out.add(arg);
      else if (arg === undefined) out.add("*");
    }
  else if (name === "printf" || name === "print") {
    const targets = printTargets(args);
    for (const target of targets.names) out.add(target);
    if (targets.unreadable) out.add("*");
  }
  if (name === "read") out.add("REPLY");
}

/**
 * Names a list may assign, plus FUNCTION_MARK + name for each function it may define. With `funcs`,
 * a call to a known function counts what its body assigns.
 */
function assignedInList(list: ListNode, out: Set<string>, funcs?: Funcs, seen?: Set<string>): void {
  for (const item of list.items) {
    const nodes = [item.node.first, ...item.node.rest.map((r) => r.node)];
    for (const node of nodes)
      for (const stage of node.stages) assignedInCommand(stage, out, funcs, seen);
  }
}

function assignedInCommand(
  command: Command,
  out: Set<string>,
  funcs?: Funcs,
  seen?: Set<string>,
): void {
  const list = (l: ListNode) => assignedInList(l, out, funcs, seen);
  switch (command.kind) {
    case "simple":
      assignedInSimple(command, out, funcs, seen);
      return;
    case "subshell":
    case "group":
      list(command.body);
      return;
    case "for":
      out.add(command.name);
      list(command.body);
      return;
    case "while":
      list(command.cond);
      list(command.body);
      return;
    case "if":
      for (const clause of command.clauses) {
        list(clause.cond);
        list(clause.body);
      }
      if (command.otherwise) list(command.otherwise);
      return;
    case "case":
      for (const branch of command.branches) list(branch.body);
      return;
    case "function":
      out.add(FUNCTION_MARK + command.name);
      return;
  }
}

/**
 * An assignment to a name the analysis could not read (`*`) makes every variable unknown; a
 * function that may have been redefined becomes uncertain.
 */
function forget(state: State, names: Set<string>): void {
  for (const name of names)
    if (name.startsWith(FUNCTION_MARK)) state.funcs.set(name.slice(FUNCTION_MARK.length), null);
  if (names.has("*")) state.vars.clear();
  else for (const name of names) if (!name.startsWith(FUNCTION_MARK)) state.vars.set(name, null);
}

// --- simple commands --------------------------------------------------------------------------

const STATEFUL = new Set([
  "cd",
  "chdir",
  "pushd",
  "popd",
  "export",
  "unset",
  "read",
  "set",
  "shift",
  "printf",
  "print",
]);

function splitAssignment(word: Word): { name: string; value: Word } | undefined {
  const first = word.parts[0];
  if (typeof first !== "string") return undefined;
  const eq = first.indexOf("=");
  const name = eq < 0 ? first : first.slice(0, eq);
  if (!NAME.test(name)) return undefined;
  if (eq < 0) return undefined;
  return {
    name,
    value: { ...word, parts: [first.slice(eq + 1), ...word.parts.slice(1)], subs: [] },
  };
}

function runSimple(
  ctx: Ctx,
  node: Simple,
  state: State,
  stage: number,
  piped: boolean,
): Decision | undefined {
  const { request, profile } = ctx;
  const refusal = runSubs(
    ctx,
    [
      ...node.assigns.flatMap((a) => a.value.subs),
      ...node.argv.flatMap((w) => w.subs),
      ...node.redirects.flatMap((r) => r.target?.subs ?? []),
    ],
    state,
  );
  if (refusal) return refusal;

  // A glob in the command name or in a flag-like word expands to whatever file names exist, so
  // `r[m] -rf x` runs `rm` once a file called `rm` is there, and `--forc[e]` can become `--force`.
  const hasGlob = (word: Word) =>
    word.glob === true && plainText(word) !== "[" && plainText(word) !== "[[";
  const globbed = node.argv.find(
    (word, index) =>
      hasGlob(word) &&
      (index === 0 || word.parts.some((p) => typeof p === "string" && p.startsWith("-"))),
  );
  if (globbed)
    return human(request, "unknown", "A pattern in a command name or option requires human review");

  const values = node.assigns.map((a) => a.value);
  const words = [
    ...values,
    ...node.argv,
    ...node.redirects.flatMap((r) => (r.target ? [r.target] : [])),
  ];
  const unsafe = environmentRefs(ctx, words, state);
  if (unsafe) return unsafe;
  const known = knownVariables(words, state);
  const envs = combinations(known);
  const program = node.argv[0];
  const literal = plainText(program);
  const name = literal === undefined ? undefined : basename(literal);

  const build = (env: Record<string, string>): SimpleCommand => {
    const loose: boolean[] = [];
    const argv = node.argv.map((word) => {
      const expanded = instantiate(word, known, env, state);
      loose.push(expanded.loose);
      return expanded.text;
    });
    const redirects: Redirect[] = [];
    for (const redir of node.redirects) {
      if (!redir.target) continue;
      const redirect = toRedirect(redir, instantiate(redir.target, known, env, state).text);
      if (redirect) redirects.push(redirect);
    }
    // Standard input is the heredoc or here-string only when nothing else also feeds it: a later
    // `<file` replaces it, and zsh's multios runs both.
    let stdin: string | undefined;
    const inputs = node.redirects.filter(
      (redir) => redir.fd === "0" && (redir.op === "<<" || redir.op === "<<<" || redir.op === "<"),
    );
    const only = inputs.length === 1 ? inputs[0] : undefined;
    if (only?.op === "<<") stdin = only.body ?? "";
    else if (only?.op === "<<<" && only.target)
      stdin = `${instantiate(only.target, known, env, state).text}\n`;
    return {
      env: node.assigns.map((a) => [a.name, instantiate(a.value, known, env, state).text]),
      argv,
      redirects,
      subs: [],
      loose,
      ...(stdin === undefined ? {} : { stdin }),
    };
  };

  // A builtin the analysis must track can hide behind a variable (`X=cd; $X /etc`) or a wrapper
  // that runs it in the current shell (`command cd /etc`, `time cd /etc`).
  // Likewise a function: `time f` and `X=f; $X` run it, and only a direct call is followed.
  for (const env of envs) {
    const argv = build(env).argv;
    const effective = basename(unwrap(argv).argv[0] ?? "");
    if (STATEFUL.has(effective) && name !== effective)
      return human(
        request,
        "unknown",
        "A builtin behind a variable or wrapper requires human review",
      );
    if (
      (state.funcs.has(effective) && literal !== effective) ||
      (state.funcs.has(argv[0] ?? "") && literal !== argv[0])
    )
      return human(
        request,
        "unknown",
        "A function behind a variable or wrapper requires human review",
      );
    // `unset name` removes a function when no variable has that name, and zsh has its own
    // removers, so a recorded function could stop shadowing the real program.
    const args = unwrap(argv).argv.slice(1);
    if (
      state.funcs.size &&
      (UNDEFINES.has(effective) ||
        // bash and sh read options only before the first name: `unset touch -v` removes `touch`.
        (effective === "unset" &&
          !(args[0] === "-v" && args.slice(1).every((a) => !a.startsWith("-")))))
    )
      return human(
        request,
        "unknown",
        "Removing a definition after defining a function requires human review",
      );
  }
  if (literal !== undefined && state.funcs.has(literal)) {
    const fn = state.funcs.get(literal);
    if (!fn)
      return human(
        request,
        "unknown",
        "A function that may or may not be defined here requires human review",
      );
    return callFunction(ctx, node, fn, state, known, envs);
  }
  if (literal === "set" && plainText(node.argv[1]) === "--" && !node.assigns.length) {
    const refusal = runRedirects(ctx, node.redirects, state);
    if (refusal) return refusal;
    setPositional(ctx, state, node.argv.slice(2), known, envs);
    ctx.box.last = result(request, "code-read", "Positional parameters", true);
    return undefined;
  }

  if (!node.argv.length) {
    // Assignments on their own, or redirections with no command.
    for (const a of node.assigns)
      if (BANNED_ENV.test(a.name))
        return human(request, "unknown", "Environment override requires human review");
    if (piped && node.assigns.length)
      return human(request, "unknown", "Assignment inside a pipeline requires human review");
    for (const env of envs)
      for (const redir of node.redirects) {
        if (!redir.target) continue;
        const redirect = toRedirect(redir, instantiate(redir.target, known, env, state).text);
        if (!redirect) continue;
        for (const cwd of state.cwds) {
          const check = redirectDecision(request, redirect, profile, cwd, fillFor(ctx, piped));
          if (check) return check;
        }
      }
    for (const a of node.assigns) {
      const texts = envs.map((env) => instantiate(a.value, known, env, state).text);
      if (texts.length && texts.every((t) => SIMPLE_VALUE.test(t))) {
        const set = [...new Set(texts)];
        if (set.length <= MAX_VARIANTS) {
          state.vars.set(a.name, set);
          continue;
        }
      }
      state.vars.set(a.name, null);
    }
    ctx.box.last = result(request, "code-read", "Variable assignment", true);
    return undefined;
  }

  for (const env of envs) {
    const command = build(env);
    for (const cwd of state.cwds) {
      if (++ctx.box.calls > MAX_JUDGEMENTS)
        return human(request, "unknown", "Too many commands to verify");
      const fill = fillFor(ctx, piped);
      const decision = simpleDecision(request, command, profile, ctx.depth, stage, cwd, fill);
      if (decision.decision !== "approve") return decision;
      ctx.box.last = decision;
      if (!symlinkFree(unwrap(command.argv).argv)) {
        if (ctx.box.script.approved)
          return human(
            request,
            "unknown",
            "A command that can create symlinks may run before an approved temp path",
          );
        ctx.box.script.tainted = true;
      }
      for (const dir of createdDirectories(unwrap(command.argv).argv)) {
        if (cwd === UNKNOWN_CWD && !isAbsolute(dir)) continue;
        ctx.box.created ??= new Set();
        ctx.box.created.add(resolve(cwd, dir));
      }
    }
  }

  // A prefix assignment before a special builtin outlives the command in some shells.
  if (name && SPECIAL_BUILTINS.has(name))
    for (const a of node.assigns) state.vars.set(a.name, null);
  // `shift` moves every positional parameter down, and `set` with a non-option word (`set -e
  // pipefail`) replaces them; only `set --` is tracked.
  if (name === "shift" || name === "set") for (const p of POSITIONAL_NAMES) state.vars.set(p, null);
  // zsh `chdir` is `cd`; in bash it fails, which leaves the starting directory possible anyway.
  if (name === "cd" || name === "chdir") return changeDirectory(ctx, state, piped, envs, build);
  if (name === "export") return exportVariables(ctx, node, state, piped, known, envs);
  if (name === "unset" || name === "read" || name === "printf" || name === "print") {
    const forgotten = new Set<string>();
    assignedInSimple(node, forgotten);
    if (forgotten.has("*"))
      return human(
        request,
        "unknown",
        `${name} naming a variable it cannot be read from requires human review`,
      );
    if (name === "read" || name === "unset") {
      const flags = node.argv
        .slice(1)
        .map(plainText)
        .filter((w) => w?.startsWith("-"));
      const allowed = name === "read" ? ["-r", "-s", "-e"] : ["-v"];
      if (flags.some((flag) => !flag || !allowed.includes(flag)))
        return human(request, "unknown", `${name} with these options requires human review`);
    }
    for (const forgottenName of forgotten)
      if (BANNED_ENV.test(forgottenName))
        return human(request, "unknown", "Environment override requires human review");
    forget(state, forgotten);
  }
  return undefined;
}

/** In a loop, a pipeline or a background job, a later command can run first. */
function fillFor(ctx: Ctx, piped: boolean): Fill {
  return { script: ctx.box.script, reorder: ctx.loop > 0 || piped || !!ctx.reorder };
}

/**
 * Programs that create no symlink: they read, print, or write regular files only. Shells are here
 * because the script they run is judged with the same state.
 */
const SYMLINK_FREE = new Set([
  ...[":", "[", "test", "true", "false", "echo", "printf", "print", "pwd", "sleep", "date"],
  ...["cd", "chdir", "export", "set", "shift", "unset", "read", "local"],
  ...["cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "paste", "diff", "cmp", "jq"],
  ...["grep", "egrep", "fgrep", "rg", "sed", "ls", "stat", "file", "which", "type"],
  ...["basename", "dirname", "realpath", "readlink", "mkdir", "touch", "tee"],
  ...["rm", "rmdir", "unlink", "bash", "sh", "zsh", "dash"],
  ...["seq", "mktemp", "chmod", "find", "curl", "du", "df", "tree", "column", "nl"],
  ...["tac", "rev", "comm", "join", "fold", "od", "xxd", "shasum", "sha256sum", "md5sum", "md5"],
  ...["whoami", "id", "uname", "hostname"],
]);
/** git subcommands that leave the working tree as it is, or only add a fresh `.git`. */
const GIT_SYMLINK_FREE = new Set([
  ...["status", "log", "diff", "show", "add", "commit", "init", "rev-parse", "ls-files"],
  ...["branch", "config", "fetch", "remote", "describe", "push", "rev-list", "merge-base"],
  ...["ls-remote", "cat-file", "for-each-ref", "symbolic-ref", "shortlog", "blame", "grep"],
]);
/** gh words that put files on disk: clones, checkouts, downloads, extensions, codespace copies. */
const GH_WRITES = /^(?:clone|checkout|co|download|extension|ext|codespace|cs|sync|--clone.*)$/;
/**
 * Whether a command is known to create no symlink. Anything else may plant one anywhere, so
 * later temp paths in the script are no longer trusted. `cp` without options that copy links
 * (`-R`, `-a`, `-P`, `-d`, long options) writes a regular file.
 */
function symlinkFree(argv: string[]): boolean {
  const [path = "", ...args] = argv;
  const program = basename(path);
  if (program === "cp") return args.every((arg) => !arg.startsWith("-") || /^-[finpv]+$/.test(arg));
  if (program === "git") {
    let index = 0;
    while (args[index]?.startsWith("-"))
      index += ["-C", "-c"].includes(args[index] as string) ? 2 : 1;
    const sub = args[index] ?? "";
    return GIT_SYMLINK_FREE.has(sub) || (sub === "worktree" && args[index + 1] === "list");
  }
  if (program === "gh") return !args.some((arg) => GH_WRITES.test(arg));
  return SYMLINK_FREE.has(program);
}

/** Once a foreground loop or pipeline ends, nothing in it can run after a later command. */
function endReorder(ctx: Ctx, approved: boolean): void {
  if (ctx.loop === 0 && !ctx.reorder) ctx.box.script.approved = approved;
}

/** git clone options that take a separate value. */
const CLONE_VALUES = new Set([
  "-b",
  "--branch",
  "-o",
  "--origin",
  "-c",
  "--config",
  "--depth",
  "--reference",
  "--separate-git-dir",
  "-u",
  "--upload-pack",
  "--template",
  "-j",
  "--jobs",
  "--filter",
  "--shallow-since",
  "--shallow-exclude",
]);
/** Positional words of `args`, skipping options and the values of those in `values`. */
function positionals(args: string[], values: Set<string>): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index] ?? "";
    if (word === "--") return [...out, ...args.slice(index + 1)];
    if (values.has(word)) index++;
    else if (!word.startsWith("-")) out.push(word);
  }
  return out;
}
/**
 * Directories a command creates (as written, relative to its cwd): `mkdir` (with `-p`, every
 * ancestor too), `git clone <url> [dir]`, `git worktree add <path>`, and the destination of `cp -r`
 * or `mv`.
 */
function createdDirectories(argv: string[]): string[] {
  const [program, ...args] = argv;
  if (program === "mkdir") {
    const parents = args.some((arg) => arg === "--parents" || /^-[^-]*p/.test(arg));
    return positionals(args, new Set(["-m", "--mode"])).flatMap((dir) => {
      if (!parents) return [dir];
      const parts = dir.split("/");
      return parts.map((_, index) => parts.slice(0, index + 1).join("/") || "/");
    });
  }
  if (program === "git" && args[0] === "clone") {
    const [url, dir] = positionals(args.slice(1), CLONE_VALUES);
    if (dir) return [dir];
    const name = url
      ?.replace(/[\\/]+$/, "")
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, "");
    return name ? [name] : [];
  }
  if (program === "git" && args[0] === "worktree" && args[1] === "add") {
    const [path] = positionals(args.slice(2), new Set(["-b", "-B", "--reason"]));
    return path ? [path] : [];
  }
  if ((program === "cp" && args.some((arg) => /^-[^-]*[rRa]/.test(arg))) || program === "mv") {
    const rest = positionals(args, new Set(["-t", "-S", "--suffix"]));
    return rest.length > 1 ? [rest[rest.length - 1] as string] : [];
  }
  return [];
}

/** A relative `cd` target that does not start with `.`: CDPATH and CDABLE_VARS can redirect it. */
function bareName(word: string): boolean {
  return !isAbsolute(word) && !/^(?:\.{1,2}(?:[\\/]|$)|[\\/])/.test(word);
}
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function changeDirectory(
  ctx: Ctx,
  state: State,
  piped: boolean,
  envs: Array<Record<string, string>>,
  build: (env: Record<string, string>) => SimpleCommand,
): Decision | undefined {
  const { request } = ctx;
  if (piped || ctx.loop > 0)
    return human(
      request,
      "unknown",
      "Directory change in a loop or pipeline requires human review",
    );
  settle(state);
  let cwds: string[] = [];
  for (const env of envs) {
    const target = build(env)
      .argv.slice(1)
      .filter((word) => word !== "--");
    // A bare `cd` and `~` or `~/x` go to the home directory; `~user` and `-` stay with a human.
    const raw = target.length === 0 ? "~" : target[0];
    const word = raw === "~" || raw?.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
    if (
      target.length > 1 ||
      !word ||
      word.includes(SUBSTITUTION) ||
      /^~|[*?[\]]/.test(word) ||
      // `-N` and zsh `+N` pick directory-stack entries.
      /^[+-]/.test(word) ||
      // CDPATH (from the environment the shell inherited) redirects a relative name.
      (process.env.CDPATH && bareName(word))
    )
      return human(request, "unknown", "Directory change requires human review");
    // bash and zsh `cd` is logical: `..` drops the last written component. In physical mode (`cd
    // -P`, `set -P`, `setopt chase_links`) it leaves the symlink's target. When the two differ, which
    // one the shell uses is unknown here, so a person decides.
    let next: string[];
    try {
      next = state.cwds.map((cwd) => {
        const logical = resolve(cwd, word);
        if (canonical(logical) !== canonical(resolveWord(cwd, raw as string)))
          throw new Error("Logical and physical directories differ");
        // A bare name that is not a directory, and that no earlier command creates, fails in a
        // plain shell; options set in rc files (zsh CDABLE_VARS, a CDPATH set there) can still send
        // it anywhere. The shell is then somewhere unknown, so nothing relative is approved there.
        // `created` is recorded when a command is judged, not when it runs; with CDABLE_VARS a
        // variable of the same name wins when the directory was not made.
        if (
          bareName(word) &&
          !isDirectory(logical) &&
          (!ctx.box.created?.has(logical) ||
            state.vars.has(word) ||
            process.env[word] !== undefined)
        )
          return UNKNOWN_CWD;
        return logical;
      });
    } catch {
      return human(request, "unknown", "Directory change requires human review");
    }
    cwds = [...new Set([...cwds, ...next])];
  }
  if (!cwds.length || cwds.length + state.cwds.length > MAX_DIRECTORIES)
    return human(request, "unknown", "Too many directory changes to verify");
  // `cd` can fail, so the directory it started from stays possible unless `&&` follows.
  state.failed = state.cwds;
  state.cwds = cwds;
  ctx.box.last = result(request, "code-read", "Directory change", true);
  return undefined;
}

function exportVariables(
  ctx: Ctx,
  node: Simple,
  state: State,
  piped: boolean,
  known: Map<string, string[]>,
  envs: Array<Record<string, string>>,
): Decision | undefined {
  const { request } = ctx;
  if (piped) return human(request, "unknown", "Export inside a pipeline requires human review");
  for (const arg of node.argv.slice(1)) {
    const text = plainText(arg);
    if (text?.startsWith("-"))
      return human(request, "unknown", "export with options requires human review");
    const assignment = splitAssignment(arg);
    if (!assignment) {
      if (text !== undefined && NAME.test(text)) continue; // exports an existing variable
      return human(request, "unknown", "export of a computed name requires human review");
    }
    if (BANNED_ENV.test(assignment.name))
      return human(request, "unknown", "Environment override requires human review");
    const texts = envs.map((env) => instantiate(assignment.value, known, env, state).text);
    if (texts.length && texts.every((t) => SIMPLE_VALUE.test(t)))
      state.vars.set(assignment.name, [...new Set(texts)]);
    else state.vars.set(assignment.name, null);
  }
  return undefined;
}

// --- positional parameters and functions ------------------------------------------------------

function clearPositional(state: State): Map<string, string[] | null> {
  const saved = new Map<string, string[] | null>();
  for (const [name, values] of state.vars)
    if (/^[0-9]+$/.test(name)) {
      saved.set(name, values);
      state.vars.delete(name);
    }
  return saved;
}

/**
 * The values each argument word gives, in order. A word that could split into a different number
 * of words (an unquoted unknown, a glob) makes every later position unknown. Known values are
 * single plain words, so bash and zsh (which does not split unquoted parameters) agree.
 */
function argumentSlots(
  words: Word[],
  state: State,
  known: Map<string, string[]>,
  envs: Array<Record<string, string>>,
): Array<string[] | null> {
  const slots: Array<string[] | null> = [];
  const add = (values: Set<string>) =>
    slots.push(
      values.size <= MAX_VARIANTS && [...values].every((v) => SIMPLE_VALUE.test(v))
        ? [...values]
        : null,
    );
  for (const word of words) {
    const texts = envs.map((env) => instantiate(word, known, env, state));
    if (word.glob || texts.some((t) => t.loose)) return slots;
    add(new Set(texts.map((t) => t.text)));
  }
  return slots;
}

/** Stores positional values; with tracking off (the script names zsh's `argv`) they are unknown. */
function bindPositional(ctx: Ctx, state: State, slots: Array<string[] | null>): void {
  for (const [index, values] of slots.entries())
    if (index < POSITIONAL_NAMES.length)
      state.vars.set(String(index + 1), ctx.positional ? values : null);
}

function setPositional(
  ctx: Ctx,
  state: State,
  words: Word[],
  known: Map<string, string[]>,
  envs: Array<Record<string, string>>,
): void {
  const slots = argumentSlots(words, state, known, envs);
  clearPositional(state);
  bindPositional(ctx, state, slots);
}

/**
 * A call runs the body in this shell with the arguments as positional parameters; the caller's
 * parameters come back afterwards. Words were already checked by the caller.
 */
function callFunction(
  ctx: Ctx,
  node: Simple,
  fn: FunctionNode,
  state: State,
  known: Map<string, string[]>,
  envs: Array<Record<string, string>>,
): Decision | undefined {
  const { request } = ctx;
  if (node.assigns.length)
    return human(request, "unknown", "An assignment before a function call requires human review");
  if (ctx.calls >= MAX_CALL_DEPTH)
    return human(request, "unknown", "Function calls are nested too deeply");
  const refusal = runRedirects(ctx, node.redirects, state);
  if (refusal) return refusal;
  const slots = argumentSlots(node.argv.slice(1), state, known, envs);
  const saved = clearPositional(state);
  bindPositional(ctx, state, slots);
  // `return` can stop the body anywhere, so the state after the call is any point in it: what the
  // body assigns is unknown, and a directory change in between cannot be followed.
  const returns = mayRun(fn.body.body, new Set(["return"]), state.funcs);
  const moves = mayRun(fn.body.body, new Set(["cd", "chdir", "pushd", "popd"]), state.funcs);
  const inner = { ...ctx, calls: ctx.calls + 1 };
  const target = fn.body.kind === "subshell" ? copy(state) : state;
  const body = runList(inner, fn.body.body, target);
  if (body) return body;
  if (returns && moves && fn.body.kind === "group")
    return human(
      request,
      "unknown",
      "A function that can return early and change directory requires human review",
    );
  if (returns) {
    const changed = new Set<string>();
    assignedInList(fn.body.body, changed, state.funcs);
    forget(state, changed);
  }
  clearPositional(state);
  for (const [name, values] of saved) state.vars.set(name, values);
  return undefined;
}

/**
 * True when a command named in `names`, or one whose name is not a literal, may run in the list,
 * including in the bodies of known functions it calls. Substitutions run in a subshell and are
 * not searched.
 */
function mayRun(
  list: ListNode,
  names: Set<string>,
  funcs: Funcs,
  seen = new Set<string>(),
): boolean {
  const lists = (ls: ListNode[]) => ls.some((l) => mayRun(l, names, funcs, seen));
  const command = (c: Command): boolean => {
    switch (c.kind) {
      case "simple": {
        if (!c.argv.length) return false;
        const program = plainText(c.argv[0]);
        if (program === undefined || names.has(basename(program))) return true;
        const fn = funcs.get(program);
        if (fn === null) return true;
        if (fn && !seen.has(program)) {
          seen.add(program);
          return mayRun(fn.body.body, names, funcs, seen);
        }
        return c.argv.slice(1).some((w) => names.has(plainText(w) ?? ""));
      }
      // A function the body defines or redefines may be called later in it.
      case "function":
        return mayRun(c.body.body, names, funcs, seen);
      case "subshell":
        return false;
      case "group":
        return lists([c.body]);
      case "for":
        return lists([c.body]);
      case "while":
        return lists([c.cond, c.body]);
      case "if":
        return lists([
          ...c.clauses.flatMap((cl) => [cl.cond, cl.body]),
          ...(c.otherwise ? [c.otherwise] : []),
        ]);
      case "case":
        return lists(c.branches.map((b) => b.body));
    }
  };
  return list.items.some((item) =>
    // zsh runs a pipeline's last stage in this shell, so every stage is searched.
    [item.node.first, ...item.node.rest.map((r) => r.node)].some((p) => p.stages.some(command)),
  );
}

/**
 * Names a shell may resolve before a function of the same name: zsh reserved words and precommand
 * modifiers, and other builtins that run or look up commands.
 */
const NOT_A_FUNCTION = new Set([
  "time",
  "command",
  "builtin",
  "exec",
  "noglob",
  "nocorrect",
  "coproc",
  "nohup",
  "source",
  "eval",
  "type",
  "whence",
  "which",
  "hash",
  "enable",
  "disable",
  "autoload",
  "functions",
  "unfunction",
  "alias",
]);

/** Builtins that can remove or replace a function definition. */
const UNDEFINES = new Set(["unfunction", "unhash", "disable", "enable", "functions", "autoload"]);

/**
 * Functions a shell runs with no call: zsh's special functions (zshmisc "Special Functions": the
 * hooks and TRAPxxx traps) and the not-found handlers of zsh and bash.
 */
const SHELL_HOOK =
  /^(?:TRAP[A-Z0-9]+|chpwd|precmd|preexec|periodic|zshexit|zshaddhistory|command_not_found_handler|command_not_found_handle)$/;

function defineFunction(ctx: Ctx, node: FunctionNode, state: State): Decision | undefined {
  // sh and dash find a special builtin before a function, so the call would not be followed.
  if (
    SPECIAL_BUILTINS.has(node.name) ||
    STATEFUL.has(node.name) ||
    NOT_A_FUNCTION.has(node.name) ||
    BANNED_ENV.test(node.name)
  )
    return human(ctx.request, "unknown", "A function named like a builtin requires human review");
  if (SHELL_HOOK.test(node.name))
    return human(ctx.request, "unknown", "A shell hook function requires human review");
  state.funcs.set(node.name, node);
  ctx.box.last = result(ctx.request, "code-read", "Function definition", true);
  return undefined;
}

/** Programs that never read standard input. */
const NO_INPUT = new Set([
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  ":",
  "basename",
  "dirname",
  "pwd",
  "sleep",
  "ls",
  "mkdir",
]);
const GH_NO_INPUT = new Set([
  "pr view",
  "pr list",
  "pr checks",
  "pr diff",
  "issue view",
  "issue list",
  "run view",
  "run list",
  "repo view",
  "release view",
  "release list",
]);

/**
 * True when nothing in the list can read the standard input it inherits. A loop body that reads
 * it would consume part of what `read` was going to see, so `read` could return any part of a line.
 */
function readsNoInput(list: ListNode, funcs: Funcs): boolean {
  const words = (w: Word[]) =>
    w.every((word) =>
      word.subs.every((inner) => {
        const script = parseScript(inner);
        return !!script && readsNoInput(script, funcs);
      }),
    );
  const ownInput = (redirs: Redir[]) =>
    redirs.some((r) => r.fd === "0" && (r.op === "<" || r.op === "<<" || r.op === "<<<"));
  const command = (c: Command): boolean => {
    if (c.kind !== "function" && !words(c.redirects.flatMap((r) => (r.target ? [r.target] : []))))
      return false;
    switch (c.kind) {
      case "simple": {
        if (!words([...c.argv, ...c.assigns.map((a) => a.value)])) return false;
        if (!c.argv.length || ownInput(c.redirects)) return true;
        const [program, first, second] = c.argv.slice(0, 3).map(plainText);
        if (program === undefined || funcs.has(program)) return false;
        return NO_INPUT.has(program) || (program === "gh" && GH_NO_INPUT.has(`${first} ${second}`));
      }
      case "function":
        return true;
      case "for":
        return words(c.words) && (ownInput(c.redirects) || readsNoInput(c.body, funcs));
      case "case":
        return (
          words([c.word]) &&
          (ownInput(c.redirects) || c.branches.every((b) => readsNoInput(b.body, funcs)))
        );
      case "if":
        return (
          ownInput(c.redirects) ||
          (c.clauses.every((cl) => readsNoInput(cl.cond, funcs) && readsNoInput(cl.body, funcs)) &&
            (!c.otherwise || readsNoInput(c.otherwise, funcs)))
        );
      case "while":
        return (
          ownInput(c.redirects) || (readsNoInput(c.cond, funcs) && readsNoInput(c.body, funcs))
        );
      case "subshell":
      case "group":
        return ownInput(c.redirects) || readsNoInput(c.body, funcs);
    }
  };
  return list.items.every((item) =>
    [item.node.first, ...item.node.rest.map((r) => r.node)].every((p) => p.stages.every(command)),
  );
}

/**
 * `while read a b; do ...; done <<< 'literal'` (or a quoted heredoc): what `read` assigns for each
 * line of the input.
 */
function readValues(
  node: Extract<Command, { kind: "while" }>,
  state: State,
): Array<Map<string, string[] | null>> | undefined {
  if (node.until || !readsNoInput(node.body, state.funcs)) return undefined;
  const item = node.cond.items.length === 1 ? node.cond.items[0] : undefined;
  const pipeline = item && !item.background && !item.node.rest.length ? item.node.first : undefined;
  const stage = pipeline?.stages.length === 1 && !pipeline.negated ? pipeline.stages[0] : undefined;
  if (stage?.kind !== "simple" || stage.assigns.length || stage.redirects.length) return undefined;
  const args = stage.argv.map(plainText);
  if (args[0] !== "read") return undefined;
  const raw = args.includes("-r");
  const names = args.slice(1).filter((a) => a !== "-r");
  if (!names.length || names.some((n) => n === undefined || !NAME.test(n) || BANNED_ENV.test(n)))
    return undefined;
  const inputs = node.redirects.filter((r) => r.fd === "0");
  const input = inputs.length === 1 ? inputs[0] : undefined;
  let text: string | undefined;
  if (input?.op === "<<") text = `${input.body ?? ""}\n`;
  else if (input?.op === "<<<" && input.target) {
    const known = knownVariables([input.target], state);
    const envs = combinations(known);
    if (envs.length !== 1) return undefined;
    text = `${instantiate(input.target, known, envs[0] as Record<string, string>, state).text}\n`;
  }
  if (text === undefined || text.includes(SUBSTITUTION) || (!raw && text.includes("\\")))
    return undefined;
  const lines = text.split("\n").slice(0, -1);
  if (!lines.length || lines.length > MAX_VARIANTS) return undefined;
  return lines.map((line) => {
    const out = new Map<string, string[] | null>();
    let rest = line.replace(/^[ \t]+|[ \t]+$/g, "");
    for (const [index, name] of (names as string[]).entries()) {
      let value = rest;
      if (index < names.length - 1) {
        const match = /^(\S*)[ \t]*(.*)$/.exec(rest) as RegExpExecArray;
        value = match[1] as string;
        rest = match[2] as string;
      }
      out.set(name as string, SIMPLE_VALUE.test(value) ? [value] : null);
    }
    return out;
  });
}

// --- compound commands ------------------------------------------------------------------------

function runCommand(
  ctx: Ctx,
  command: Command,
  state: State,
  stage: number,
  piped: boolean,
): Decision | undefined {
  // A compound command's redirections are opened before its body runs, in the directory it
  // started in; a `cd` inside the body cannot move them.
  if (command.kind !== "simple" && command.kind !== "function") {
    const early = runRedirects(ctx, command.redirects, copy(state));
    if (early) return early;
  }
  switch (command.kind) {
    case "simple":
      return runSimple(ctx, command, state, stage, piped);
    case "subshell":
      return runList(ctx, command.body, copy(state)) ?? runRedirects(ctx, command.redirects, state);
    case "group":
      return runList(ctx, command.body, state) ?? runRedirects(ctx, command.redirects, state);
    case "for":
      return runFor(ctx, command, state);
    case "while":
      return runWhile(ctx, command, state);
    case "if":
      return runIf(ctx, command, state);
    case "case":
      return runCase(ctx, command, state);
    case "function":
      return defineFunction(ctx, command, state);
  }
}

function runFor(
  ctx: Ctx,
  node: Extract<Command, { kind: "for" }>,
  state: State,
): Decision | undefined {
  if (BANNED_ENV.test(node.name))
    return human(ctx.request, "unknown", "Environment override requires human review");
  const approved = ctx.box.script.approved;
  const refusal = runSubs(
    ctx,
    node.words.flatMap((w) => w.subs),
    state,
  );
  if (refusal) return refusal;
  const unsafe = environmentRefs(ctx, node.words, state);
  if (unsafe) return unsafe;
  const known = knownVariables(node.words, state);
  const values = new Set<string>();
  let unknown = false;
  for (const env of combinations(known))
    for (const word of node.words) {
      const text = instantiate(word, known, env, state).text;
      if (SIMPLE_VALUE.test(text)) values.add(text);
      else unknown = true;
    }
  if (!values.size || values.size > MAX_VARIANTS) unknown = true;
  const changed = new Set<string>([node.name]);
  assignedInList(node.body, changed, state.funcs);
  // Each pass is judged on its own, from a start where everything the body assigns is unknown, so
  // values that belong together (the words of one item) stay together.
  for (const value of unknown ? [null] : [...values]) {
    if (++ctx.box.calls > MAX_JUDGEMENTS)
      return human(ctx.request, "unknown", "Too many commands to verify");
    const inner = copy(state);
    forget(inner, changed);
    inner.vars.set(node.name, value === null ? null : [value]);
    const body = runList({ ...ctx, loop: ctx.loop + 1 }, node.body, inner);
    if (body) return body;
  }
  endReorder(ctx, approved);
  forget(state, changed);
  return runRedirects(ctx, node.redirects, state);
}

function runWhile(
  ctx: Ctx,
  node: Extract<Command, { kind: "while" }>,
  state: State,
): Decision | undefined {
  const changed = new Set<string>();
  assignedInList(node.cond, changed, state.funcs);
  assignedInList(node.body, changed, state.funcs);
  const inner = copy(state);
  forget(inner, changed);
  const approved = ctx.box.script.approved;
  const loop = { ...ctx, loop: ctx.loop + 1 };
  const refusal = runList(loop, node.cond, inner);
  if (refusal) return refusal;
  // With literal input, each pass is judged with what `read` took from its line.
  for (const line of readValues(node, state) ?? [undefined]) {
    if (++ctx.box.calls > MAX_JUDGEMENTS)
      return human(ctx.request, "unknown", "Too many commands to verify");
    const pass = line ? copy(inner) : inner;
    if (line) for (const [name, values] of line) pass.vars.set(name, values);
    const body = runList(loop, node.body, pass);
    if (body) return body;
  }
  endReorder(ctx, approved);
  forget(state, changed);
  return runRedirects(ctx, node.redirects, state);
}

function runIf(
  ctx: Ctx,
  node: Extract<Command, { kind: "if" }>,
  state: State,
): Decision | undefined {
  const branches: State[] = [];
  let current = state;
  for (const [index, clause] of node.clauses.entries()) {
    // The first condition always runs; later ones only when every earlier one failed.
    const conditionState = index === 0 ? current : copy(current);
    const outcome: { success?: State } = {};
    const refusal = runList(ctx, clause.cond, conditionState, outcome);
    if (refusal) return refusal;
    if (index > 0) current = merge(current, conditionState);
    // The body runs only when the condition succeeded: an `a && b` condition ran both, and a `cd`
    // that ends the condition did change directory. Earlier clauses are already merged in.
    const taken = copy(outcome.success ?? current);
    delete taken.failed;
    const body = runList(ctx, clause.body, taken);
    if (body) return body;
    branches.push(taken);
  }
  if (node.otherwise) {
    const taken = copy(current);
    const body = runList(ctx, node.otherwise, taken);
    if (body) return body;
    branches.push(taken);
  } else branches.push(current);
  const merged = branches.reduce((a, b) => merge(a, b));
  if (merged.cwds.length > MAX_DIRECTORIES)
    return human(ctx.request, "unknown", "Too many directory changes to verify");
  replace(state, merged);
  return runRedirects(ctx, node.redirects, state);
}

function runCase(
  ctx: Ctx,
  node: Extract<Command, { kind: "case" }>,
  state: State,
): Decision | undefined {
  const words = [node.word, ...node.branches.flatMap((b) => b.patterns)];
  const refusal =
    runSubs(
      ctx,
      words.flatMap((w) => w.subs),
      state,
    ) ?? environmentRefs(ctx, words, state);
  if (refusal) return refusal;
  let merged = copy(state);
  for (const branch of node.branches) {
    const taken = copy(state);
    const body = runList(ctx, branch.body, taken);
    if (body) return body;
    merged = merge(merged, taken);
  }
  if (merged.cwds.length > MAX_DIRECTORIES)
    return human(ctx.request, "unknown", "Too many directory changes to verify");
  replace(state, merged);
  return runRedirects(ctx, node.redirects, state);
}

// --- lists, pipelines and the entry point -----------------------------------------------------

/**
 * True when the pipeline always succeeds: `true`, `:`, or `cd` to an absolute directory that exists
 * and can be entered now. Only used to know that an `&&` chain goes on past it; the directory it
 * started from is still kept as possible.
 */
function cannotFail(ctx: Ctx, node: PipelineNode, state: State): boolean {
  const stage = node.stages.length === 1 && !node.negated ? node.stages[0] : undefined;
  if (stage?.kind !== "simple" || stage.assigns.length || stage.redirects.length) return false;
  const argv = stage.argv.map(plainText);
  const [program, target] = argv;
  if (program === undefined || state.funcs.has(program)) return false;
  if ((program === "true" || program === ":") && argv.length === 1) return true;
  // An earlier command (`mv`, a background job) could remove the directory, so only the script's
  // first command is trusted. Another process can still change it before the script runs.
  if (program !== "cd" || argv.length !== 2 || target === undefined || node !== ctx.box.first)
    return false;
  const path =
    target === "~" || target.startsWith("~/") ? join(homedir(), target.slice(1)) : target;
  if (!path.startsWith("/") || /[*?[\]]/.test(path)) return false;
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** With `outcome`, also reports the state when the list's exit status is success. */
function runList(
  ctx: Ctx,
  list: ListNode,
  state: State,
  outcome?: { success?: State },
): Decision | undefined {
  for (const [index, item] of list.items.entries()) {
    const last = index === list.items.length - 1;
    // Each item runs whether or not the one before it succeeded.
    settle(state);
    // A background job runs in a subshell of its own.
    const target = item.background ? copy(state) : state;
    const { first, rest } = item.node;
    const refusal = runPipeline(item.background ? { ...ctx, reorder: true } : ctx, first, target);
    if (refusal) return refusal;
    if (!rest.length) {
      if (last && outcome) outcome.success = copy(item.background ? state : target);
      continue;
    }
    // In `a && b || c` each later command runs only if the ones before it did, so it sees their
    // effects, but the chain may stop after any of them: the state afterwards is every prefix's.
    // An all-`&&` chain cannot stop after a step that cannot fail, and succeeds only at the end.
    const chain = rest.every((r) => r.op === "&&");
    let running = copy(target);
    let possible = copy(target);
    // Variables after the chain: the steps it can stop after. Directories always use `possible`.
    let assigned = chain && cannotFail(ctx, first, target) ? undefined : copy(target);
    // While every operator so far is `&&`, a command runs only if everything before it succeeded,
    // so a `cd` before it did change directory. After an `||` any earlier directory is possible.
    let onlyAnd = true;
    for (const [step, next] of rest.entries()) {
      running = copy(running);
      onlyAnd &&= next.op === "&&";
      if (onlyAnd) delete running.failed;
      else {
        settle(running);
        running.cwds = [...new Set([...running.cwds, ...possible.cwds])];
      }
      const skipped = runPipeline(ctx, next.node, running);
      if (skipped) return skipped;
      possible = merge(possible, running);
      if (!chain || step === rest.length - 1 || !cannotFail(ctx, next.node, running))
        assigned = assigned ? merge(assigned, running) : copy(running);
      if (possible.cwds.length > MAX_DIRECTORIES)
        return human(ctx.request, "unknown", "Too many directory changes to verify");
    }
    if (assigned) {
      possible.vars = assigned.vars;
      possible.funcs = assigned.funcs;
    }
    if (last && outcome)
      outcome.success = copy(item.background ? state : chain ? running : possible);
    replace(target, possible);
  }
  return undefined;
}

function runPipeline(
  ctx: Ctx,
  node: { stages: Command[]; negated?: boolean },
  state: State,
): Decision | undefined {
  if (node.stages.length === 1) {
    const refusal = runCommand(ctx, node.stages[0] as Command, state, 0, false);
    // `! cd x` succeeds exactly when the `cd` failed.
    if (node.negated) settle(state);
    return refusal;
  }
  const changed = new Set<string>();
  const approved = ctx.box.script.approved;
  for (const [index, stage] of node.stages.entries()) {
    assignedInCommand(stage, changed, state.funcs);
    const refusal = runCommand(ctx, stage, copy(state), index, true);
    if (refusal) return refusal;
  }
  endReorder(ctx, approved);
  // The last stage may run in the current shell, so what the stages assign is unknown afterwards.
  forget(state, changed);
  return undefined;
}

/**
 * Evaluates a compound command. `cd <literal>` is tracked: every later command is judged in each
 * directory it could run in (before and after the `cd`, since `cd x || ...` may fail), so a command
 * that only looks safe relative to the starting directory cannot hide behind a `cd`.
 */
export function commandDecision(
  request: Request,
  command: string,
  profile: Profile,
  depth = 0,
  start: string[] = [request.cwd],
  fill?: Fill,
): Decision {
  const script = parseScript(command);
  if (!script) return human(request, "unknown", UNSUPPORTED);
  const ctx: Ctx = {
    request,
    profile,
    depth,
    loop: 0,
    calls: 0,
    positional: !/argv/.test(command),
    box: { calls: 0, script: fill?.script ?? { tainted: false, approved: false } },
    ...(fill?.reorder ? { reorder: true } : {}),
  };
  const opening = script.items[0];
  if (depth === 0 && opening && !opening.background) ctx.box.first = opening.node.first;
  const refusal = runList(ctx, script, { cwds: [...start], vars: new Map(), funcs: new Map() });
  return refusal ?? ctx.box.last ?? human(request, "unknown", "Empty command");
}
