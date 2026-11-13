import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AuditLog } from "@agent-corpus/audit-log";
import { hash, words } from "./policy.js";
import type { Request } from "./types.js";

const vocabulary = new Set(
  "git az aws gcloud cat rm terraform resource group network monitor servicebus queue topic storage blob webapp appservice containerapp vm disk ec2 rds s3api cloudformation logs cloudwatch sqs sns ecs eks compute instances projects container run sql pubsub logging monitoring log-analytics workspace boards work-item account list show query create update delete destroy purge status diff log fetch origin branch worktree add describe-instances describe-volumes describe-stacks".split(
    " ",
  ),
);
const tools = new Set(
  "Read Write Edit view create edit Bash bash powershell exec_command apply_patch shell read_file write_file".split(
    " ",
  ),
);

export function sessionDirectoryPath(harness: string, sessionId: string): string {
  if (!sessionId || !["claude", "codex", "copilot"].includes(harness))
    throw new Error("A harness and session ID are required");
  return join(
    tmpdir(),
    `acp-${process.getuid?.() ?? "user"}-${hash([harness, sessionId]).slice(0, 24)}`,
  );
}

export function sessionDirectory(harness: string, sessionId: string): string {
  const path = sessionDirectoryPath(harness, sessionId);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
  )
    throw new Error("Unsafe session directory");
  return path;
}
export function sessionToken(directory: string): string {
  const path = join(directory, "token");
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (lstatSync(path).isSymbolicLink()) throw new Error("Unsafe token file");
  return readFileSync(path, "utf8");
}
export function audit(directory: string, event: Record<string, unknown>): void {
  const { event: name, summary, requestHash, ...attributes } = event;
  if (typeof name !== "string") throw new Error("Invalid policy audit event");
  new AuditLog(directory).append({
    eventName: name,
    source:
      name === "human-response" || name === "execution-result"
        ? "policy-manager.adapter-report"
        : "policy-manager",
    sessionId: basename(directory),
    ...(typeof requestHash === "string" && /^[a-f0-9]{64}$/.test(requestHash)
      ? { requestId: requestHash }
      : {}),
    severityText: name === "evaluation-failure" ? "ERROR" : "INFO",
    ...(typeof summary === "string" ? { summary } : {}),
    attributes,
  });
}
export function requestSummary(request: Request): Record<string, unknown> {
  // MCP arguments are tool-specific: record only hashes of the tool name and argument keys.
  if (request.tool.startsWith("mcp__"))
    return {
      summary: "MCP tool operation",
      action: "tool operation",
      tool: "mcp",
      requestHash: hash(request),
      harness: request.harness,
      sessionHash: hash(request.sessionId),
      cwdHash: hash(request.cwd),
      toolHash: hash(request.tool),
      inputKeys: Object.keys(request.input).map((key) => hash(key)),
      executable: "other",
    };
  const command = request.input.command ?? request.input.cmd;
  const argv = typeof command === "string" ? words(command) : undefined;
  const operation = argv?.slice(0, 4).filter((word, index) => index === 0 || !word.startsWith("-"));
  const action = operation?.map((word) => (vocabulary.has(word) ? word : "[REDACTED]")).join(" ");
  const file = request.input.file_path ?? request.input.path;
  const selectors = new Set([
    "--ids",
    "--name",
    "--resource-group",
    "--subscription",
    "--project",
    "--namespace-name",
    "--workspace",
    "--region",
    "--zone",
  ]);
  const targets =
    argv?.flatMap((word, index) =>
      selectors.has(word) && argv[index + 1] !== undefined
        ? [{ selector: word, valueHash: hash(argv[index + 1]) }]
        : [],
    ) ?? [];
  return {
    summary:
      action ??
      (tools.has(request.tool) ? `${request.tool} tool operation` : "Unrecognized tool operation"),
    action: action ?? "tool operation",
    tool: tools.has(request.tool) ? request.tool : "other",
    ...(typeof file === "string" ? { targetHash: hash([request.cwd, file]) } : {}),
    ...(targets.length ? { targets } : {}),
    requestHash: hash(request),
    harness: request.harness,
    sessionHash: hash(request.sessionId),
    cwdHash: hash(request.cwd),
    toolHash: hash(request.tool),
    inputKeys: Object.keys(request.input).map((key) => hash(key)),
    // Keep action terms and hashed targets; omit raw payloads and argument values.
    executable:
      argv && /^(?:git|az|aws|gcloud|cat|rm|terraform)$/.test(argv[0] ?? "") ? argv[0] : "other",
  };
}
