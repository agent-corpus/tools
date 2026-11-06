import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, words } from "./policy.js";
import type { Request } from "./types.js";

export function sessionDirectory(harness: string, sessionId: string): string {
  if (!sessionId || !["claude", "codex", "copilot"].includes(harness))
    throw new Error("A harness and session ID are required");
  const path = join(
    tmpdir(),
    `acp-${process.getuid?.() ?? "user"}-${hash([harness, sessionId]).slice(0, 24)}`,
  );
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
  const file = join(directory, "audit.jsonl");
  try {
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe audit file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`, {
    mode: 0o600,
    flag: "a",
  });
  chmodSync(file, 0o600);
}
export function requestSummary(request: Request): Record<string, unknown> {
  const command = request.input.command ?? request.input.cmd;
  const argv = typeof command === "string" ? words(command) : undefined;
  return {
    requestHash: hash(request),
    harness: request.harness,
    sessionHash: hash(request.sessionId),
    cwdHash: hash(request.cwd),
    toolHash: hash(request.tool),
    inputKeys: Object.keys(request.input).map((key) => hash(key)),
    // Never record command arguments, paths, file contents, prompts, or model explanations.
    executable:
      argv && /^(?:git|az|aws|gcloud|cat|rm|terraform)$/.test(argv[0] ?? "") ? argv[0] : "other",
  };
}
