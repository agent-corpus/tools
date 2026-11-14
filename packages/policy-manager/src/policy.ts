import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { branchEvidence, canonical, git, inside, pathEvidence } from "./evidence.js";
import {
  commandDecision,
  permissiveRead,
  permissiveWrite,
  WORKTREE_DELETION,
} from "./permissive.js";
import { mcpReadOnly, type Profile, strictProfile } from "./profile.js";
import { redactText } from "./redact.js";
import {
  CATEGORIES,
  type Category,
  type Classification,
  type Decision,
  type Request,
} from "./types.js";

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Shell tools whose `description` only labels the command. Elsewhere it can be content. */
export const SHELL_TOOLS = new Set(["Bash", "bash", "exec_command", "shell"]);
/** The correlation hash of a request, over its effect-relevant input only. */
export function requestHash(request: Request): string {
  if (!SHELL_TOOLS.has(request.tool)) return hash(request);
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
/**
 * Escalations that stay with a human in every profile. Category `sensitive` (credentials,
 * secrets, protected paths and configuration) is excluded by category; these are the remaining
 * boundaries: the request itself cannot be trusted, an organization or the profile asked for a
 * human, or a repository rule forbids the write. Of `destructive`, only deletion inside a linked
 * feature worktree is classified: recoverable is approved, anything else goes to a person.
 */
const HUMAN_BOUNDARIES: RegExp[] = [
  /^Incomplete request/,
  /^Invalid tool input/,
  /^Execution directory differs/,
  /^Unrecognized patch format/,
  /^Patch has no verified target paths/,
  /^Environment override requires human review/,
  /^Custom execution environment requires human review/,
  /^Matches an organization human-approval pattern/,
  /^Write requires a linked worktree on a feature branch/,
  /^Cloud operation is outside the verified inspection catalog/,
];
/**
 * Under the permissive profile, every escalation that is not a boundary is ambiguous: the
 * deterministic engine cannot decide it, so the session's AI classifier does. Strict mode is
 * unchanged.
 */
function markAmbiguous(decision: Decision, profile: Profile): Decision {
  if (
    profile.mode !== "permissive" ||
    decision.decision !== "human" ||
    decision.needsClassification ||
    decision.category === "sensitive" ||
    // Git history, remote, cloud, publish and HTTP deletions are not provably recoverable, and the
    // classifier is not independent; only local deletion inside a feature worktree is classified.
    (decision.category === "destructive" && decision.reason !== WORKTREE_DELETION) ||
    HUMAN_BOUNDARIES.some((pattern) => pattern.test(decision.reason))
  )
    return decision;
  return { ...decision, needsClassification: true, tier: "ambiguous" };
}
function resolveAmbiguous(decision: Decision, ai: Classification): Decision {
  // A `destructive` verdict approves only what the engine proved is a deletion inside a feature
  // worktree; on anything else (an unparsable `rm -rf ~/{a,b}`) the label alone means a person.
  const destructiveOk = ai.category !== "destructive" || decision.reason === WORKTREE_DELETION;
  const safe =
    ai.recoverable === true &&
    ai.confidence >= AMBIGUOUS_CONFIDENCE &&
    destructiveOk &&
    !["sensitive", "unknown"].includes(ai.category);
  const base = { ...decision, needsClassification: false, cache: "session" as const, ai };
  if (safe)
    return {
      ...base,
      decision: "approve",
      category: ai.category,
      classification: "approved",
      reason: "Ambiguous request judged recoverable and non-sensitive by the same-session AI",
    };
  const why = ai.rationale ? ` Rationale: ${redactText(ai.rationale, 200)}` : "";
  // Possible unrecoverable loss is a person's decision, not a deny the model works around.
  if (decision.category === "destructive" || ai.category === "destructive")
    return {
      ...base,
      decision: "human",
      cache: "none",
      classification: "denied",
      reason: `Destructive request not judged recoverable by the classifier (confidence ${ai.confidence}, recoverable ${ai.recoverable ?? "not stated"}); a person decides.${why}`,
    };
  return {
    ...base,
    decision: "deny",
    classification: "denied",
    reason: `Not run: the classifier did not approve this request (category ${ai.category}, confidence ${ai.confidence}, recoverable ${ai.recoverable ?? "not stated"}).${why} Use a recoverable, non-sensitive alternative, or explain to the user what is needed.`,
  };
}
export function evaluate(
  request: Request,
  ai?: Classification,
  profile: Profile = strictProfile,
): Decision {
  const decision = markAmbiguous(evaluateCore(request, profile), profile);
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
  const cwd = input.workdir ?? input.cwd ?? request.cwd;
  if (typeof cwd !== "string" || cwd !== request.cwd)
    return result(request, "unknown", "Execution directory differs from the reviewed directory");
  const file = input.file_path ?? input.path;
  if (request.tool === "apply_patch" && typeof input.command === "string") {
    const lines = input.command.split("\n");
    if (lines[0] !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch")
      return result(request, "unknown", "Unrecognized patch format");
    const paths: string[] = [];
    for (const line of lines) {
      if (line.startsWith("*** Delete File: "))
        return result(request, "destructive", "File deletion requires human approval");
      for (const prefix of ["*** Add File: ", "*** Update File: ", "*** Move to: "])
        if (line.startsWith(prefix)) paths.push(line.slice(prefix.length));
    }
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
    ["Read", "view", "read_file", "Edit", "Write", "edit", "create", "write_file"].includes(
      request.tool,
    ) &&
    typeof file === "string"
  ) {
    const write = !["Read", "view", "read_file"].includes(request.tool);
    const evidence =
      profile.mode === "permissive"
        ? write
          ? permissiveWrite(request.cwd, file, profile)
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
    if (args[0] === "branch" && args.some((a) => a === "-d" || a === "-D" || a === "--delete"))
      return result(request, "destructive", branchEvidence(gitCwd, args.at(-1) ?? ""));
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
