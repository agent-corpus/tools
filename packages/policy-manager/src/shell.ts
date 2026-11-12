// Compatibility view of the script parser for callers that only handle plain commands: simple
// commands joined by `;`, newlines, `&&`, `||` and `|`, with literal words. Anything else
// (variables, compound commands, heredocs, background jobs) returns undefined. The evaluator uses
// `parseScript` directly.

import {
  type AndOr,
  type Command,
  parseScript,
  type Redir,
  type Simple,
  SUBSTITUTION,
  type Word,
} from "./script.js";

export { SUBSTITUTION } from "./script.js";

export interface Redirect {
  fd: string;
  op: ">" | ">>" | "<" | ">&";
  target: string;
}
export interface SimpleCommand {
  env: Array<[string, string]>;
  argv: string[];
  redirects: Redirect[];
  /** Inner commands of `$(...)`, backticks and process substitutions in this command's words. */
  subs: string[];
  /** For each argv word, whether it contains an unquoted unknown value (it could split). */
  loose?: boolean[];
  /** Literal text fed to standard input by a heredoc or here-string, when there is one. */
  stdin?: string;
}
export type Pipeline = SimpleCommand[];

/** Text of a word with no variable references; unknown parts become SUBSTITUTION. */
function literalText(word: Word): string | undefined {
  let text = "";
  for (const part of word.parts) {
    if (typeof part === "string") text += part;
    else if ("unknown" in part) text += SUBSTITUTION;
    else return undefined;
  }
  return text;
}

function plainRedirect(redir: Redir): Redirect | undefined {
  if (redir.op === "<<" || redir.op === "<<<" || !redir.target) return undefined;
  const target = literalText(redir.target);
  return target === undefined ? undefined : { fd: redir.fd, op: redir.op, target };
}

function plainSimple(command: Command): SimpleCommand | undefined {
  if (command.kind !== "simple") return undefined;
  const simple: Simple = command;
  if (!simple.argv.length) return undefined;
  const env: Array<[string, string]> = [];
  const subs: string[] = [];
  for (const { name, value } of simple.assigns) {
    const text = literalText(value);
    if (text === undefined) return undefined;
    env.push([name, text]);
    subs.push(...value.subs);
  }
  const argv: string[] = [];
  const loose: boolean[] = [];
  for (const word of simple.argv) {
    const text = literalText(word);
    if (text === undefined) return undefined;
    argv.push(text);
    loose.push(word.parts.some((p) => typeof p !== "string" && "unknown" in p && !p.quoted));
    subs.push(...word.subs);
  }
  const redirects: Redirect[] = [];
  for (const redir of simple.redirects) {
    const plain = plainRedirect(redir);
    if (!plain) return undefined;
    redirects.push(plain);
    subs.push(...(redir.target?.subs ?? []));
  }
  return { env, argv, redirects, subs, loose };
}

function flatten(andOr: AndOr): Pipeline[] | undefined {
  const pipelines: Pipeline[] = [];
  for (const node of [andOr.first, ...andOr.rest.map((r) => r.node)]) {
    if (node.negated) return undefined;
    const stages: Pipeline = [];
    for (const stage of node.stages) {
      const simple = plainSimple(stage);
      if (!simple) return undefined;
      stages.push(simple);
    }
    pipelines.push(stages);
  }
  return pipelines;
}

export function parseShell(command: string): Pipeline[] | undefined {
  const script = parseScript(command);
  if (!script) return undefined;
  const pipelines: Pipeline[] = [];
  for (const item of script.items) {
    if (item.background) return undefined;
    const flat = flatten(item.node);
    if (!flat) return undefined;
    pipelines.push(...flat);
  }
  return pipelines.length ? pipelines : undefined;
}
