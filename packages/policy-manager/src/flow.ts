import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BANNED_ENV, human, redirectDecision, simpleDecision, unwrap } from "./permissive.js";
import { result } from "./policy.js";
import type { Profile } from "./profile.js";
import {
  type Command,
  type ListNode,
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

interface State {
  cwds: string[];
  /**
   * Variables the script assigned: their known values, or null when the value is unknown (it came
   * from a command, a glob or a loop). A name that is absent was never assigned here, so it is an
   * environment variable of unknown content.
   */
  vars: Map<string, string[] | null>;
}
interface Ctx {
  request: Request;
  profile: Profile;
  depth: number;
  loop: number;
  box: { last?: Decision; calls: number };
}

const copy = (state: State): State => ({ cwds: [...state.cwds], vars: new Map(state.vars) });

function merge(a: State, b: State): State {
  const vars = new Map<string, string[] | null>();
  for (const [name, left] of a.vars) {
    if (!b.vars.has(name)) continue; // assigned on one path only: an environment value is possible
    const right = b.vars.get(name);
    const union = left && right ? [...new Set([...left, ...right])] : null;
    vars.set(name, union && union.length <= MAX_VARIANTS ? union : null);
  }
  return { cwds: [...new Set([...a.cwds, ...b.cwds])], vars };
}

function replace(target: State, source: State): void {
  target.cwds = source.cwds;
  target.vars = source.vars;
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

function environmentRefs(ctx: Ctx, words: Word[], state: State): Decision | undefined {
  for (const word of words)
    for (const part of word.parts)
      if (
        typeof part === "object" &&
        "name" in part &&
        !state.vars.has(part.name) &&
        !ENVIRONMENT_OK.has(part.name)
      )
        return human(
          ctx.request,
          "unknown",
          "An environment variable of unknown content requires human review",
        );
  return undefined;
}

function knownVariables(words: Word[], state: State): Map<string, string[]> {
  const names = new Set<string>();
  for (const word of words)
    for (const part of word.parts)
      if (typeof part === "object" && "name" in part) names.add(part.name);
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

/** Text of a word for one choice of variable values; unknown parts become SUBSTITUTION. */
function instantiate(
  word: Word,
  known: Map<string, string[]>,
  env: Record<string, string>,
): { text: string; loose: boolean } {
  let text = "";
  let loose = false;
  for (const part of word.parts) {
    if (typeof part === "string") text += part;
    else if ("unknown" in part) {
      text += SUBSTITUTION;
      loose ||= !part.quoted;
    } else if (known.has(part.name)) text += env[part.name] ?? "";
    else {
      text += SUBSTITUTION;
      loose ||= !part.quoted;
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
      const redirect = toRedirect(redir, instantiate(redir.target, known, env).text);
      if (!redirect) continue;
      for (const cwd of state.cwds) {
        const check = redirectDecision(ctx.request, redirect, ctx.profile, cwd);
        if (check) return check;
      }
    }
  return undefined;
}

// --- assigned names ---------------------------------------------------------------------------

function assignedInSimple(node: Simple, out: Set<string>): void {
  if (!node.argv.length) {
    for (const a of node.assigns) out.add(a.name);
    return;
  }
  const name = basename(plainText(node.argv[0]) ?? "");
  const args = node.argv.slice(1).map(plainText);
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
  else if (name === "printf" && args[0] === "-v" && args[1]) out.add(args[1]);
  if (name === "read") out.add("REPLY");
}

function assignedInList(list: ListNode, out: Set<string>): void {
  for (const item of list.items) {
    const nodes = [item.node.first, ...item.node.rest.map((r) => r.node)];
    for (const node of nodes) for (const stage of node.stages) assignedInCommand(stage, out);
  }
}

function assignedInCommand(command: Command, out: Set<string>): void {
  switch (command.kind) {
    case "simple":
      assignedInSimple(command, out);
      return;
    case "subshell":
    case "group":
      assignedInList(command.body, out);
      return;
    case "for":
      out.add(command.name);
      assignedInList(command.body, out);
      return;
    case "while":
      assignedInList(command.cond, out);
      assignedInList(command.body, out);
      return;
    case "if":
      for (const clause of command.clauses) {
        assignedInList(clause.cond, out);
        assignedInList(clause.body, out);
      }
      if (command.otherwise) assignedInList(command.otherwise, out);
      return;
    case "case":
      for (const branch of command.branches) assignedInList(branch.body, out);
      return;
  }
}

/** An assignment to a name the analysis could not read (`*`) makes every variable unknown. */
function forget(state: State, names: Set<string>): void {
  if (names.has("*")) state.vars.clear();
  else for (const name of names) state.vars.set(name, null);
}

// --- simple commands --------------------------------------------------------------------------

const STATEFUL = new Set(["cd", "pushd", "popd", "export", "unset", "read", "set", "shift"]);

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
      const expanded = instantiate(word, known, env);
      loose.push(expanded.loose);
      return expanded.text;
    });
    const redirects: Redirect[] = [];
    for (const redir of node.redirects) {
      if (!redir.target) continue;
      const redirect = toRedirect(redir, instantiate(redir.target, known, env).text);
      if (redirect) redirects.push(redirect);
    }
    let stdin: string | undefined;
    for (const redir of node.redirects) {
      if (redir.fd !== "0") continue;
      if (redir.op === "<<") stdin = redir.body ?? "";
      else if (redir.op === "<<<" && redir.target)
        stdin = `${instantiate(redir.target, known, env).text}\n`;
    }
    return {
      env: node.assigns.map((a) => [a.name, instantiate(a.value, known, env).text]),
      argv,
      redirects,
      subs: [],
      loose,
      ...(stdin === undefined ? {} : { stdin }),
    };
  };

  // A builtin the analysis must track can hide behind a variable (`X=cd; $X /etc`) or a wrapper
  // that runs it in the current shell (`command cd /etc`, `time cd /etc`).
  for (const env of envs) {
    const effective = basename(unwrap(build(env).argv).argv[0] ?? "");
    if (STATEFUL.has(effective) && name !== effective)
      return human(
        request,
        "unknown",
        "A builtin behind a variable or wrapper requires human review",
      );
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
        const redirect = toRedirect(redir, instantiate(redir.target, known, env).text);
        if (!redirect) continue;
        for (const cwd of state.cwds) {
          const check = redirectDecision(request, redirect, profile, cwd);
          if (check) return check;
        }
      }
    for (const a of node.assigns) {
      const texts = envs.map((env) => instantiate(a.value, known, env).text);
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
      const decision = simpleDecision(request, command, profile, ctx.depth, stage, cwd);
      if (decision.decision !== "approve") return decision;
      ctx.box.last = decision;
    }
  }

  if (name === "cd") return changeDirectory(ctx, state, piped, envs, build);
  if (name === "export") return exportVariables(ctx, node, state, piped, known, envs);
  if (name === "unset" || name === "read" || name === "printf") {
    const forgotten = new Set<string>();
    assignedInSimple(node, forgotten);
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
  let cwds = [...state.cwds];
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
      word.startsWith("-")
    )
      return human(request, "unknown", "Directory change requires human review");
    // `cd` can fail, so the directory it started from stays possible.
    cwds = [...new Set([...cwds, ...state.cwds.map((cwd) => resolve(cwd, word))])];
  }
  if (cwds.length > MAX_DIRECTORIES)
    return human(request, "unknown", "Too many directory changes to verify");
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
    const texts = envs.map((env) => instantiate(assignment.value, known, env).text);
    if (texts.length && texts.every((t) => SIMPLE_VALUE.test(t)))
      state.vars.set(assignment.name, [...new Set(texts)]);
    else state.vars.set(assignment.name, null);
  }
  return undefined;
}

// --- compound commands ------------------------------------------------------------------------

function runCommand(
  ctx: Ctx,
  command: Command,
  state: State,
  stage: number,
  piped: boolean,
): Decision | undefined {
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
  }
}

function runFor(
  ctx: Ctx,
  node: Extract<Command, { kind: "for" }>,
  state: State,
): Decision | undefined {
  if (BANNED_ENV.test(node.name))
    return human(ctx.request, "unknown", "Environment override requires human review");
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
      const text = instantiate(word, known, env).text;
      if (SIMPLE_VALUE.test(text)) values.add(text);
      else unknown = true;
    }
  if (!values.size || values.size > MAX_VARIANTS) unknown = true;
  const changed = new Set<string>([node.name]);
  assignedInList(node.body, changed);
  const inner = copy(state);
  forget(inner, changed);
  inner.vars.set(node.name, unknown ? null : [...values]);
  const body = runList({ ...ctx, loop: ctx.loop + 1 }, node.body, inner);
  if (body) return body;
  forget(state, changed);
  return runRedirects(ctx, node.redirects, state);
}

function runWhile(
  ctx: Ctx,
  node: Extract<Command, { kind: "while" }>,
  state: State,
): Decision | undefined {
  const changed = new Set<string>();
  assignedInList(node.cond, changed);
  assignedInList(node.body, changed);
  const inner = copy(state);
  forget(inner, changed);
  const loop = { ...ctx, loop: ctx.loop + 1 };
  const refusal = runList(loop, node.cond, inner) ?? runList(loop, node.body, inner);
  if (refusal) return refusal;
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
    const refusal = runList(ctx, clause.cond, conditionState);
    if (refusal) return refusal;
    if (index > 0) current = merge(current, conditionState);
    const taken = copy(current);
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

function runList(ctx: Ctx, list: ListNode, state: State): Decision | undefined {
  for (const item of list.items) {
    // A background job runs in a subshell of its own.
    const target = item.background ? copy(state) : state;
    const { first, rest } = item.node;
    const refusal = runPipeline(ctx, first, target);
    if (refusal) return refusal;
    if (!rest.length) continue;
    // In `a && b || c` each later command runs only if the ones before it did, so it sees their
    // effects, but the chain may stop after any of them: the state afterwards is every prefix's.
    let running = copy(target);
    let possible = copy(target);
    for (const next of rest) {
      running = copy(running);
      const skipped = runPipeline(ctx, next.node, running);
      if (skipped) return skipped;
      possible = merge(possible, running);
      if (possible.cwds.length > MAX_DIRECTORIES)
        return human(ctx.request, "unknown", "Too many directory changes to verify");
    }
    replace(target, possible);
  }
  return undefined;
}

function runPipeline(ctx: Ctx, node: { stages: Command[] }, state: State): Decision | undefined {
  if (node.stages.length === 1) return runCommand(ctx, node.stages[0] as Command, state, 0, false);
  const changed = new Set<string>();
  for (const [index, stage] of node.stages.entries()) {
    assignedInCommand(stage, changed);
    const refusal = runCommand(ctx, stage, copy(state), index, true);
    if (refusal) return refusal;
  }
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
): Decision {
  const script = parseScript(command);
  if (!script) return human(request, "unknown", UNSUPPORTED);
  const ctx: Ctx = { request, profile, depth, loop: 0, box: { calls: 0 } };
  const refusal = runList(ctx, script, { cwds: [...start], vars: new Map() });
  return refusal ?? ctx.box.last ?? human(request, "unknown", "Empty command");
}
