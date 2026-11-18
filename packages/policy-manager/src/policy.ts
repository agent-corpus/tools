import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { computesProgram } from "./clirun.js";
import {
  branchEvidence,
  canonical,
  git,
  inside,
  pathEvidence,
  resolveWord,
  withEvidence,
} from "./evidence.js";
import { hardRule, hardRules, patchField, readsPolicySecret } from "./hard.js";

/** Tools that write a file (a shell command is judged by the engine itself). */
const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "create",
  "edit",
  "write_file",
  "apply_patch",
]);

import { credentialUse } from "./creduse.js";
import { onRemote } from "./merged.js";
import { commandDecision, permissiveRead, permissiveWrite } from "./permissive.js";
import { mcpReadOnly, type Profile, strictProfile } from "./profile.js";
import { enterable, plainRead, readOnly, unsafeGlob } from "./reads.js";
import { redactText } from "./redact.js";
import { parseShell } from "./shell.js";
import { scan } from "./shellscan.js";
import { defaultAllowed } from "./tools.js";
import {
  CATEGORIES,
  type Category,
  type Classification,
  type Decision,
  type Request,
} from "./types.js";

/**
 * The files a Codex `apply_patch` changes, or undefined for a patch that does not follow the
 * format: `*** Begin Patch`, then file sections, then `*** End Patch` (a trailing newline and
 * CRLF line endings are fine). A section is `*** Add File: <path>` with `+` lines,
 * `*** Delete File: <path>`, or `*** Update File: <path>` with an optional `*** Move to: <path>`
 * and hunks: `@@` (with or without context text), then ` `, `+` and `-` lines, and an optional
 * `*** End of File`. A path may be absolute, relative, a Windows path, or contain spaces.
 */
export function parsePatch(text: string): { targets: string[]; deletes: string[] } | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines.at(-1) === "") lines.pop();
  if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch")
    return undefined;
  const targets: string[] = [];
  const deletes: string[] = [];
  const header = (line: string, name: string) => {
    const prefix = `*** ${name}: `;
    if (!line.startsWith(prefix)) return undefined;
    const path = line.slice(prefix.length).trim();
    return path && !/[\0\r\n]/.test(path) ? path : "";
  };
  let section: "add" | "update" | "delete" | undefined;
  let afterHeader = false;
  for (const line of lines.slice(1, -1)) {
    const add = header(line, "Add File");
    const update = header(line, "Update File");
    const remove = header(line, "Delete File");
    const move = header(line, "Move to");
    if (add === "" || update === "" || remove === "" || move === "") return undefined;
    if (add !== undefined) {
      targets.push(add);
      section = "add";
    } else if (update !== undefined) {
      targets.push(update);
      section = "update";
      afterHeader = true;
      continue;
    } else if (remove !== undefined) {
      deletes.push(remove);
      section = "delete";
    } else if (move !== undefined) {
      if (section !== "update" || !afterHeader) return undefined;
      targets.push(move);
    } else if (section === "add") {
      if (!line.startsWith("+")) return undefined;
    } else if (section === "update") {
      if (!/^(?:@@|[ +-]|\*\*\* End of File$)/.test(line) && line !== "") return undefined;
    } else return undefined;
    afterHeader = false;
  }
  return { targets, deletes };
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Shell tools whose `description` only labels the command. Elsewhere it can be content. */
export const SHELL_TOOLS = new Set(["Bash", "bash", "exec_command", "shell"]);
/** The correlation hash of a request, over its effect-relevant input only. */
/** Input fields that name a file, for deciding whether a file tool depends on its cwd. */
const PATH_FIELDS = ["file_path", "path", "notebook_path", "dir_path"];
export function requestHash(request: Request): string {
  if (!SHELL_TOOLS.has(request.tool)) {
    // What a file tool does depends on its paths, not on bookkeeping (a tool-use id, a
    // description) or, when every path is absolute, on the session's working directory.
    const paths = PATH_FIELDS.map((key) => request.input?.[key]).filter((v) => v !== undefined);
    // Only file tools: elsewhere a description can be content (an MCP work item body).
    if (!paths.length) return hash(request);
    const input = Object.fromEntries(
      Object.entries(request.input ?? {}).filter(
        ([key]) => !/^(?:description|tool_use_id|toolUseId)$/.test(key),
      ),
    );
    const absolute =
      paths.length > 0 &&
      paths.every(
        (value) => typeof value === "string" && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value),
      );
    return hash({ ...request, input, ...(absolute ? { cwd: "" } : {}) });
  }
  const input = Object.fromEntries(
    Object.entries(request.input ?? {}).filter(([key]) => key !== "description"),
  );
  return hash({ ...request, input });
}
// Deliberately accepts one simple command. Shell syntax and expansions need human review.
export function words(command: string): string[] | undefined {
  if (!command || /[\r\n\0]/.test(command)) return undefined;
  const result: string[] = [];
  let current = "",
    quote = "",
    active = false;
  for (const char of command) {
    if (quote) {
      if (quote === '"' && /[$`\\]/.test(char)) return undefined;
      if (char === quote) quote = "";
      else current += char;
      active = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/[$`;&|<>(){}*?~!\\[\]#=]/.test(char)) return undefined;
    else if (/\s/.test(char)) {
      if (active) {
        result.push(current);
        current = "";
        active = false;
      }
    } else {
      current += char;
      active = true;
    }
  }
  if (quote) return undefined;
  if (active) result.push(current);
  return result.length ? result : undefined;
}
const cloudReads = new Map<string, string[]>([
  [
    "az boards work-item show",
    ["--id", "--org", "--organization", "--project", "--query", "--output", "-o"],
  ],
  ["az resource list", ["--resource-group", "--subscription", "--query", "--output", "-o"]],
  [
    "az resource show",
    [
      "--ids",
      "--name",
      "--resource-group",
      "--resource-type",
      "--subscription",
      "--query",
      "--output",
      "-o",
    ],
  ],
  ["az group list", ["--subscription", "--query", "--output", "-o"]],
  [
    "az monitor log-analytics workspace list",
    ["--resource-group", "--subscription", "--query", "--output", "-o"],
  ],
  [
    "az monitor log-analytics query",
    [
      "--workspace",
      "--analytics-query",
      "--timespan",
      "--query",
      "--output",
      "-o",
      "--subscription",
    ],
  ],
  ["aws ec2 describe-instances", ["--region", "--profile", "--query", "--output"]],
  ["aws ec2 describe-volumes", ["--region", "--profile", "--query", "--output"]],
  [
    "aws cloudformation describe-stacks",
    ["--stack-name", "--region", "--profile", "--query", "--output"],
  ],
  ["aws sts get-caller-identity", ["--region", "--profile", "--query", "--output"]],
  ["gcloud compute instances list", ["--project", "--filter", "--format"]],
  ["gcloud projects list", ["--filter", "--format"]],
]);
function cloudRead(argv: string[]): boolean {
  for (const [prefix, flags] of cloudReads) {
    const start = prefix.split(" ");
    if (!start.every((part, index) => argv[index] === part)) continue;
    const rest = argv.slice(start.length);
    for (let index = 0; index < rest.length; index += 2) {
      const flag = rest[index];
      const value = rest[index + 1];
      if (!flag || !flags.includes(flag) || value === undefined || value.startsWith("-"))
        return false;
    }
    return true;
  }
  return false;
}
function cloudReadCandidate(argv: string[]): boolean {
  const options = [
    "--resource-group",
    "--subscription",
    "--name",
    "--ids",
    "--resource-type",
    "--namespace-name",
    "--query",
    "--output",
    "-o",
    "--region",
    "--profile",
    "--project",
    "--zone",
    "--filter",
    "--format",
  ];
  const firstOption = argv.findIndex((arg) => arg.startsWith("-"));
  const operation = firstOption < 0 ? argv : argv.slice(0, firstOption);
  const flags = firstOption < 0 ? [] : argv.slice(firstOption);
  if (!operation.slice(1).every((arg) => /^[a-z][a-z0-9-]*$/.test(arg))) return false;
  for (let index = 0; index < flags.length; index += 2)
    if (
      !options.includes(flags[index] ?? "") ||
      flags[index + 1] === undefined ||
      flags[index + 1]?.startsWith("-")
    )
      return false;
  const metadataOperations = new Set([
    "az network vnet list",
    "az network vnet show",
    "az network nic list",
    "az network nic show",
    "az network nsg list",
    "az network nsg show",
    "az network public-ip list",
    "az network public-ip show",
    "az servicebus namespace list",
    "az servicebus namespace show",
    "az servicebus queue list",
    "az servicebus queue show",
    "az servicebus topic list",
    "az servicebus topic show",
    "az storage account list",
    "az storage account show",
    "aws ec2 describe-security-groups",
    "aws ec2 describe-subnets",
    "aws ec2 describe-vpcs",
    "gcloud compute networks list",
    "gcloud compute networks describe",
  ]);
  return metadataOperations.has(operation.join(" "));
}

export function result(
  request: Request,
  category: Category,
  reason: string,
  approve = false,
): Decision {
  return {
    decision: approve ? "approve" : "human",
    category,
    reason,
    requestHash: requestHash(request),
    cache: approve && category === "cloud-read" ? "session" : "none",
    cached: false,
  };
}
/** Self-reported confidence needed for the AI to approve an ambiguous request. */
export const AMBIGUOUS_CONFIDENCE = 0.95;
/** The reason a plain read of non-secret files is approved, protected configuration included. */
export const PLAIN_READ = "Plain read of non-secret files";
/**
 * Escalations the classifier is never asked about because the request itself cannot be judged
 * from what it is shown: an incomplete or malformed request, a working directory other than the
 * reviewed one, an unreadable patch, or a custom environment the classifier does not see.
 */
const NOT_CLASSIFIABLE: RegExp[] = [
  /^Incomplete request/,
  /^Invalid tool input/,
  /^Execution directory differs/,
  /^Unrecognized patch format/,
  /^Patch has no verified target paths/,
  /^Environment override requires human review/,
  /^Custom execution environment requires human review/,
];
/**
 * Every escalation the engine cannot decide goes to the AI classifier, in every profile, unless it
 * is a hard human item (credentials, protected configuration, unrecoverable loss, humanPatterns),
 * which goes straight to a person, or cannot be judged from what the classifier is shown.
 */
function markAmbiguous(request: Request, decision: Decision, profile: Profile): Decision {
  if (decision.decision !== "human") return decision;
  const hard = hardRule(request, decision, profile.scratchRoots);
  if (hard) return { ...decision, needsClassification: false, tier: undefined, hard };
  if (NOT_CLASSIFIABLE.some((pattern) => pattern.test(decision.reason))) return decision;
  return { ...decision, needsClassification: true, tier: "ambiguous" };
}
/**
 * Approves iff `recoverable && confidence >= 0.95 && category not in {sensitive, unknown}`.
 * Anything else is a person's decision; the engine's reason is kept (session grants key on it)
 * and the classifier's answer is shown beside it.
 */
function resolveAmbiguous(decision: Decision, ai: Classification): Decision {
  const safe =
    ai.recoverable === true &&
    ai.confidence >= AMBIGUOUS_CONFIDENCE &&
    !["sensitive", "unknown"].includes(ai.category);
  const base = { ...decision, needsClassification: false, ai };
  if (safe)
    return {
      ...base,
      decision: "approve",
      cache: "session",
      category: ai.category,
      classification: "approved",
      reason: "Judged recoverable and non-sensitive by the AI classifier",
    };
  const why = ai.rationale ? `: ${redactText(ai.rationale, 200)}` : "";
  return {
    ...base,
    decision: "human",
    cache: "none",
    classification: "denied",
    classifierNote: `The AI classifier did not approve it (category ${ai.category}, confidence ${ai.confidence}, recoverable ${ai.recoverable ?? "not stated"})${why}`,
  };
}
export const CHAIN_APPROVED = "A read-only prefix followed by a command approved on its own";
/** A word as a single-quoted shell word. */
const quote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
/**
 * A chain (`a && b; c`) whose commands before the last only read (or `cd` into an existing
 * directory), and whose last command the engine approves on its own in every directory the `cd`s
 * could leave it in. Earlier commands change nothing the last one could see, so judging it alone
 * is judging it in place. Rejected outright: substitutions, variables, assignments, globs,
 * here-documents, background jobs, `CDPATH`, and pipes (unless every stage only reads). The last
 * command still gets every check, hard human items included.
 */
function chainApproved(request: Request, profile: Profile): boolean {
  const command = request.input.command ?? request.input.cmd;
  if (!SHELL_TOOLS.has(request.tool) || typeof command !== "string" || command.length > 20_000)
    return false;
  const pipelines = parseShell(command);
  if (!pipelines || pipelines.length < 2 || pipelines.length > 24) return false;
  const cwds = new Set([request.cwd]);
  for (const [index, pipeline] of pipelines.entries()) {
    const last = index === pipelines.length - 1;
    for (const cmd of pipeline) {
      if (cmd.env.length || cmd.subs.length || cmd.stdin !== undefined) return false;
      if (cmd.loose?.some(Boolean) || unsafeGlob(cmd.argv, cmd.glob)) return false;
    }
    if (pipeline.length > 1 && !pipeline.every((cmd) => readOnly(cmd.argv))) return false;
    const [cmd] = pipeline;
    if (!cmd) return false;
    if (cmd.argv[0] === "cd") {
      const target = cmd.argv[1];
      if (
        last ||
        pipeline.length > 1 ||
        cmd.argv.length !== 2 ||
        !target ||
        target.startsWith("-") ||
        cmd.redirects.length ||
        (process.env.CDPATH && !/^[/~.]/.test(target))
      )
        return false;
      // As the script's first command, a `cd` that cannot fail leaves only its target.
      // After `||` the next command runs exactly when it fails, so `||` anywhere keeps the old one.
      const sure = index === 0 && !command.includes("||") ? enterable(target) : undefined;
      if (sure) {
        cwds.clear();
        cwds.add(sure);
        continue;
      }
      const next = new Set<string>();
      for (const dir of cwds) {
        try {
          const to = resolveWord(dir, target);
          if (!existsSync(to)) return false;
          next.add(to);
        } catch {
          return false;
        }
      }
      // `cd x || y` may leave the old directory; keep every place the next command could run.
      for (const dir of next) cwds.add(dir);
      if (cwds.size > 4) return false;
      continue;
    }
    if (!last) {
      // Output may only go nowhere: a read-only command that writes a file is not read-only.
      const quiet = cmd.redirects.every(
        (r) => (r.op === ">&" && r.target === "1") || (r.op === ">" && r.target === "/dev/null"),
      );
      if (!quiet) return false;
      // Only reads, and only of what a plain read may name (`readable`): the prefix's output
      // reaches the agent too. Every stage gets the full plain-read check, file readers and
      // filters (`jq`, `cut`, `wc`, `diff`, `sort`) alike.
      for (const stage of pipeline) {
        if (!readOnly(stage.argv)) return false;
        const text = stage.argv.map(quote).join(" ");
        for (const cwd of cwds)
          if (!plainRead({ ...request, cwd, input: { command: text } }, profile.scratchRoots))
            return false;
      }
      continue;
    }
    const text = pipeline
      .map((stage) =>
        [
          ...stage.argv.map(quote),
          ...stage.redirects.map(
            (r) => `${r.fd}${r.op}${r.op === ">&" ? r.target : quote(r.target)}`,
          ),
        ].join(" "),
      )
      .join(" | ");
    for (const cwd of cwds) {
      const input = { ...request.input, command: text };
      if ("workdir" in input) input.workdir = cwd;
      if ("cwd" in input) input.cwd = cwd;
      if (evaluate({ ...request, cwd, input }, undefined, profile).decision !== "approve")
        return false;
    }
  }
  return true;
}
/** Most words of a shell command the engine judges; here-document bodies do not count. */
export const MAX_WORDS = 1_000;
export const TOO_MANY_WORDS = "Command has too many words to check";
/** Whether a script has more than MAX_WORDS words outside here-documents (one linear scan). */
function tooManyWords(command: string): boolean {
  let count = 0;
  for (const segment of scan(command).segments)
    for (const word of segment) if (!word.heredoc && ++count > MAX_WORDS) return true;
  return false;
}
/** Why a command whose program name is computed at run time is not approved by the engine. */
export const COMPUTED_PROGRAM =
  "The program name is computed at run time, so what runs needs review";
/** Hard items no step approves, the engine's included: the deterministic floor. */
const FLOOR = new Set(["cloud-write", "repo-delete", "publish", "rm-outside", "policy-state"]);
export const FLOOR_REASON =
  "A cloud, repository, publishing or deletion command outside disposable roots needs a person";
/** Why a request that could change the policy manager's own files needs a person. */
export const POLICY_STATE_REASON =
  "Could change the policy manager's own files (its session state in the temp directory); needs a person";
/**
 * The decision for a request. The floor runs after the engine: a cloud or infrastructure write, a
 * repository deletion, a publish or a recursive delete outside disposable roots is never approved,
 * whatever rule approved it, and asks instead.
 */
export function evaluate(
  request: Request,
  ai?: Classification,
  profile: Profile = strictProfile,
): Decision {
  return withEvidence(() => evaluateOnce(request, ai, profile));
}

function evaluateOnce(
  request: Request,
  ai: Classification | undefined,
  profile: Profile,
): Decision {
  // A shell command with more words than the engine judges in time asks, before any judging.
  const command = request.input?.command ?? request.input?.cmd;
  if (SHELL_TOOLS.has(request.tool) && typeof command === "string" && tooManyWords(command))
    return result(request, "unknown", TOO_MANY_WORDS);
  // A listed credential that only flows into a listed consumer: the request is the consumer.
  const consumer =
    SHELL_TOOLS.has(request.tool) && typeof command === "string"
      ? credentialUse(command, profile.credentialUses ?? [])
      : undefined;
  if (consumer !== undefined) {
    const inner = evaluateOnce(
      { ...request, input: { ...request.input, command: consumer, cmd: undefined } },
      ai,
      profile,
    );
    return { ...inner, requestHash: requestHash(request), credentialUse: true };
  }
  const decision = evaluateSteps(request, ai, profile);
  if (decision.decision !== "approve" || !SHELL_TOOLS.has(request.tool)) return decision;
  const floor = hardRules(request, { ...decision, decision: "human" }, profile.scratchRoots).find(
    // A profile with `cloudWrites: "allow"` chose to automate non-destructive cloud writes; the
    // engine still asks for cloud deletion there.
    (rule) => FLOOR.has(rule) && !(rule === "cloud-write" && profile.cloudWrites === "allow"),
  );
  if (floor)
    return {
      ...result(
        request,
        floor === "policy-state" ? "sensitive" : "destructive",
        floor === "policy-state" ? POLICY_STATE_REASON : FLOOR_REASON,
      ),
      hard: floor,
    };
  // The session token authenticates grants: reading it, or anything beside it but the audit logs,
  // is a credential read no step approves.
  if (readsPolicySecret(request, profile.scratchRoots))
    return {
      ...result(
        request,
        "sensitive",
        "A command that shows a secret (a token, credentials, or the policy service's session files) requires a person",
      ),
      hard: "credential-read",
    };
  return decision;
}

function evaluateSteps(
  request: Request,
  ai?: Classification,
  profile: Profile = strictProfile,
): Decision {
  let core = evaluateCore(request, profile);
  // A program whose name is computed at run time (`$p$q approve`) is never approved by the
  // engine, in any profile: what runs is unknown until it runs, so the classifier or a person judges.
  const shellScript = request.input?.command ?? request.input?.cmd;
  const computed =
    SHELL_TOOLS.has(request.tool) &&
    typeof shellScript === "string" &&
    computesProgram(shellScript);
  if (computed && core.decision === "approve") core = result(request, "unknown", COMPUTED_PROGRAM);
  // A plain read of non-secret files, protected configuration included, changes nothing.
  if (
    !computed &&
    core.decision === "human" &&
    !NOT_CLASSIFIABLE.some((pattern) => pattern.test(core.reason)) &&
    plainRead(request, profile.scratchRoots)
  )
    return result(request, "code-read", PLAIN_READ, true);
  if (
    !computed &&
    core.decision === "human" &&
    !NOT_CLASSIFIABLE.some((pattern) => pattern.test(core.reason)) &&
    chainApproved(request, profile)
  )
    return result(request, "worktree-write", CHAIN_APPROVED, true);
  // What the harness lets run (its settings, hooks, permission rules) and the policy profile are
  // never approved by any step, the engine's included: wherever they live (`CLAUDE_CONFIG_DIR` in
  // a temp directory, say), a write to them asks.
  if (core.decision === "approve" && WRITE_TOOLS.has(request.tool)) {
    const tamper = hardRules(request, { ...core, decision: "human" }, profile.scratchRoots).find(
      (rule) => rule === "harness-settings" || rule === "policy-profile" || rule === "policy-state",
    );
    if (tamper)
      return {
        ...result(
          request,
          "sensitive",
          tamper === "policy-state"
            ? POLICY_STATE_REASON
            : "Harness settings and the policy profile require a person",
        ),
        hard: tamper,
      };
  }
  const decision = markAmbiguous(request, core, profile);
  // A hard human item is a person's: no classification, however confident, approves it.
  if (decision.hard) return decision;
  if (ai) {
    // Self-reported confidence is not a probability or a substitute for verified effects.
    if (
      !(CATEGORIES as readonly string[]).includes(ai.category) ||
      ai.requestHash !== decision.requestHash ||
      !Number.isFinite(ai.confidence) ||
      ai.confidence < 0 ||
      ai.confidence > 1
    )
      return {
        ...decision,
        decision: "human",
        cache: "none",
        reason: "Invalid or mismatched AI classification",
      };
    decision.ai = ai;
    if (decision.tier === "ambiguous") return resolveAmbiguous(decision, ai);
    if (
      decision.category === "cloud-read" &&
      decision.needsClassification === true &&
      ai.category === "cloud-read" &&
      ai.confidence >= 0.99
    ) {
      return {
        ...decision,
        decision: "approve",
        cache: "session",
        reason: "Bounded cloud inspection confirmed by same-session AI",
        needsClassification: false,
        ai,
      };
    }

    if (
      ai.confidence < 0.99 ||
      ai.category !== decision.category ||
      ["sensitive", "destructive", "impactful-write", "unknown"].includes(ai.category)
    )
      return {
        ...decision,
        decision: "human",
        cache: "none",
        reason: "AI classification lacks sufficient agreement with verified effects",
      };
  }
  return decision;
}
function evaluateCore(request: Request, profile: Profile): Decision {
  if (
    !request.sessionId ||
    !request.cwd ||
    !request.tool ||
    !["claude", "codex", "copilot"].includes(request.harness)
  )
    return result(request, "unknown", "Incomplete request");
  const input = request.input;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return result(request, "unknown", "Invalid tool input");
  // MCP arguments are tool-specific, so their `cwd` or `path` mean nothing here.
  if (request.tool.startsWith("mcp__"))
    return mcpReadOnly(profile, request.tool)
      ? result(request, "cloud-read", "MCP tool listed as read-only in the profile", true)
      : {
          ...result(request, "unknown", "MCP tool not listed as read-only; left to the harness"),
          decision: "native",
        };
  // Harness tools that are not shell, file, patch or MCP tools (task control, plan mode, asking
  // the user, loading tool schemas) are approved by default under the permissive profile; the
  // profile's toolsDeny keeps chosen ones on the classification path. Each approval names the tool.
  if (
    profile.mode === "permissive" &&
    defaultAllowed(request.harness, request.tool, profile.toolsDeny[request.harness] ?? [])
  )
    return {
      ...result(request, "code-read", "Harness tool approved by default", true),
      defaultTool: request.tool,
    };
  const cwd = input.workdir ?? input.cwd ?? request.cwd;
  if (typeof cwd !== "string" || cwd !== request.cwd)
    return result(request, "unknown", "Execution directory differs from the reviewed directory");
  // Only the target decides a file tool: `content`, `old_string` and `new_string` are data.
  const file = input.file_path ?? input.notebook_path ?? input.path;
  const patchText = patchField(input);
  if (request.tool === "apply_patch" && typeof patchText === "string") {
    const patch = parsePatch(patchText);
    if (!patch) return result(request, "unknown", "Unrecognized patch format");
    if (patch.deletes.length)
      return result(request, "destructive", "File deletion requires human approval");
    const paths = patch.targets;
    if (!paths.length) return result(request, "unknown", "Patch has no verified target paths");
    const checks = paths.map((path) =>
      profile.mode === "permissive"
        ? permissiveWrite(request.cwd, path, profile)
        : pathEvidence(request.cwd, path, true),
    );
    const denied = checks.find((check) => !check.allowed);
    return result(
      request,
      denied?.category ?? "worktree-write",
      denied?.reason ?? "Verified patch targets within feature worktrees",
      !denied,
    );
  }
  if (
    [
      ...["Read", "view", "read_file", "Edit", "Write", "edit", "create", "write_file"],
      ...["MultiEdit", "NotebookEdit"],
    ].includes(request.tool) &&
    typeof file === "string"
  ) {
    const write = !["Read", "view", "read_file"].includes(request.tool);
    const evidence =
      profile.mode === "permissive"
        ? write
          ? permissiveWrite(request.cwd, file, profile, undefined, false, true)
          : permissiveRead(request.cwd, file)
        : pathEvidence(request.cwd, file, write);
    return result(request, evidence.category, evidence.reason, evidence.allowed);
  }
  if (!["Bash", "bash", "powershell", "exec_command", "shell"].includes(request.tool))
    return result(
      request,
      "unknown",
      "Unknown tool or file operation; no AI classification was performed for this request, so a human decision is required",
    );
  if (request.tool === "powershell")
    return result(request, "unknown", "PowerShell semantics require human review");
  if (input.env !== undefined || input.shell !== undefined || input.stdin !== undefined)
    return result(request, "unknown", "Custom execution environment requires human review");
  const command = input.command ?? input.cmd;
  if (profile.mode === "permissive" && typeof command === "string")
    return commandDecision(request, command, profile);
  const argv = typeof command === "string" ? words(command) : undefined;
  if (!argv)
    return result(
      request,
      "unknown",
      "Unsupported shell syntax; no AI classification was performed for this request, so a human decision is required",
    );
  return evaluateArgv(request, argv);
}

/**
 * `worktree add [--no-track] <path> -b <branch> <base>` (or `-b <branch>` before the path), with
 * `origin/main` or `origin/master` as the base. Anything else is not recognised.
 */
function worktreeAddForm(
  args: string[],
): { path: string; branch: string; base: string } | undefined {
  if (args[0] !== "worktree" || args[1] !== "add") return undefined;
  const rest = args.slice(2);
  if (rest[0] === "--no-track") rest.shift();
  if (rest.length !== 4 || !/^origin\/(?:main|master)$/.test(rest[3] ?? "")) return undefined;
  const [a = "", b = "", c = "", base = ""] = rest;
  if (a === "-b" && !b.startsWith("-") && !c.startsWith("-")) return { path: c, branch: b, base };
  if (b === "-b" && !a.startsWith("-") && !c.startsWith("-")) return { path: a, branch: c, base };
  return undefined;
}

export function evaluateArgv(request: Request, argv: string[]): Decision {
  const [program, ...args] = argv;
  let gitCwd = request.cwd;
  if (program === "git" && args[0] === "-C" && args[1]) {
    gitCwd = resolve(request.cwd, args[1]);
    args.splice(0, 2);
  }
  if (
    ["rm", "rmdir", "Remove-Item"].includes(program ?? "") ||
    (program === "terraform" && args.includes("destroy"))
  )
    return result(request, "destructive", "Destructive operation requires human approval");
  if (["az", "aws", "gcloud"].includes(program ?? "")) {
    if (
      argv.some((arg) =>
        /(?:secret|credential|password|connection[-_]?strings?|app[-_]?settings|publishing|(?:^|[-_])keys?(?:$|[-_])|listKeys|access-token|get-token|kubeconfig)/i.test(
          arg,
        ),
      )
    )
      return result(request, "sensitive", "Credential or secret retrieval requires human approval");
    if (cloudRead(argv))
      return result(request, "cloud-read", "Verified cloud inspection command", true);
    if (cloudReadCandidate(argv))
      return {
        ...result(request, "cloud-read", "Cloud inspection candidate requires AI classification"),
        needsClassification: true,
      };
    return result(
      request,
      argv.some((arg) => /^(delete|destroy|purge|remove)/.test(arg))
        ? "destructive"
        : "impactful-write",
      "Cloud operation is outside the verified inspection catalog",
    );
  }
  if (program === "git") {
    if (args.join(" ") === "fetch origin") {
      try {
        git(gitCwd, ["rev-parse", "--show-toplevel"]);
        const remote = git(gitCwd, ["remote", "get-url", "origin"]);
        if (!/^(https:\/\/|ssh:\/\/|git@[a-zA-Z0-9.-]+:)/.test(remote))
          return result(request, "unknown", "Unverified Git transport");
        return result(request, "git-read", "Fetch from the repository's configured origin", true);
      } catch {
        return result(request, "unknown", "Cannot verify Git fetch target");
      }
    }
    const add = worktreeAddForm(args);
    if (add) {
      try {
        // The main checkout's root, also when the command runs in a linked worktree.
        const common = canonical(resolve(gitCwd, git(gitCwd, ["rev-parse", "--git-common-dir"])));
        const root =
          basename(common) === ".git"
            ? dirname(common)
            : canonical(git(gitCwd, ["rev-parse", "--show-toplevel"]));
        const target = canonical(resolve(gitCwd, add.path));
        git(gitCwd, ["check-ref-format", "--branch", add.branch]);
        git(gitCwd, ["rev-parse", "--verify", `${add.base}^{commit}`]);
        const parents = [resolve(root, ".worktrees"), resolve(root, ".claude", "worktrees")];
        if (
          !/^(?:main|master)$/.test(add.branch) &&
          !existsSync(target) &&
          parents.some((parent) => inside(parent, target) && target !== parent)
        )
          return result(
            request,
            "worktree-write",
            "Create a new linked feature worktree under the repository's .worktrees or .claude/worktrees directory",
            true,
          );
      } catch {
        /* Unverified worktree creation requires a human. */
      }
      return result(request, "worktree-write", "Cannot verify worktree creation targets");
    }
    if (args[0] === "branch" && args.some((a) => a === "-d" || a === "-D" || a === "--delete")) {
      const names = args.slice(1).filter((a) => !a.startsWith("-"));
      const flags = args.slice(1).filter((a) => a.startsWith("-"));
      // A branch whose tip is on a remote-tracking ref loses nothing when deleted.
      if (
        names.length &&
        flags.every((f) => ["-d", "-D", "--delete", "-q", "--quiet"].includes(f)) &&
        names.every((name) => onRemote(gitCwd, name))
      )
        return result(request, "git-read", "Deleted branches' tips are on a remote ref", true);
      return result(request, "destructive", branchEvidence(gitCwd, args.at(-1) ?? ""));
    }
    if (args.length === 1 && ["status", "diff", "log"].includes(args[0] ?? ""))
      return result(request, "git-read", "Verified Git inspection command", true);
    if (args.join(" ") === "branch --show-current" || args.join(" ") === "rev-parse HEAD")
      return result(request, "git-read", "Verified Git inspection command", true);
    return result(
      request,
      "impactful-write",
      "Git operation requires a separate approval; never grant all Git commands",
    );
  }
  if (program === "cat" && args.length > 0 && args.every((arg) => !arg.startsWith("-"))) {
    const checks = args.map((path) => pathEvidence(request.cwd, path, false));
    const denied = checks.find((check) => !check.allowed);
    return result(
      request,
      denied?.category ?? "code-read",
      denied?.reason ?? "Verified file reads",
      !denied,
    );
  }
  return result(
    request,
    "unknown",
    "Unknown executable or effects; no AI classification was performed for this request, so a human decision is required",
  );
}
