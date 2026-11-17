import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, sessionDirectory, sessionDirectoryPath, sessionToken } from "./audit.js";
import { hash, requestHash } from "./policy.js";
import { loadProfile, type Profile, strictProfile } from "./profile.js";
import { GrantError, PolicySession } from "./session.js";
import type { Classification, OutcomeReport, Request } from "./types.js";

interface Message {
  token: string;
  action:
    | "ping"
    | "review"
    | "classify"
    | "record"
    | "grant"
    | "refuse"
    | "await"
    | "harness"
    | "pending"
    | "stop";
  request?: Request;
  classification?: Classification;
  report?: OutcomeReport;
  phase?: string;
  grant?: { requestHash: string; confirm: boolean; session?: boolean };
  /** Claude Code's `permission_mode` for a PreToolUse: whether an ask reaches a person. */
  permissionMode?: string;
  /** A waiting hook's own end of the wait (`await`): no approval came in time. */
  waitOutcome?: "timeout";
  /** The harness process above the hook (`harness`), for approve's ancestry check. */
  harnessPid?: number;
  /** Claude Code's `tool_use_id` for a PreToolUse or PostToolUse. */
  toolUseId?: string;
  /** A PostToolUseFailure's error text and interrupt flag, to tell a rejected prompt from a run. */
  failure?: { error?: string; interrupted?: boolean };
}
/** How long a hook waits for a review, which can include the AI classifier's run. */
export const REVIEW_TIMEOUT_MS = 40_000;
/** How often a hook waiting for the user's approval asks the service whether it came. */
export const APPROVAL_POLL_MS = 1_000;
export type ApprovalState = "granted" | "refused" | "pending" | "gone";
/** Consecutive failed polls (other than a refused connection) after which the service is gone. */
const POLL_FAILURES = 3;
/**
 * Waits until `deadline` (epoch ms) for the user's answer to a request that needs a person,
 * asking `poll` every `intervalMs`. Returns `granted`, `refused`, `gone` (it can no longer be
 * approved), `unreachable` (the service is not there: a refused connection or a missing socket at
 * once, any other failure after POLL_FAILURES in a row) or `timeout`. A failed poll is never an
 * answer.
 */
export async function waitForApproval(
  poll: () => Promise<unknown>,
  deadline: number,
  intervalMs = APPROVAL_POLL_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<Exclude<ApprovalState, "pending"> | "timeout" | "unreachable"> {
  let failures = 0;
  while (Date.now() < deadline) {
    let state: unknown;
    try {
      state = await poll();
      failures = 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOENT" || ++failures >= POLL_FAILURES)
        return "unreachable";
      state = "pending";
    }
    if (state === "granted" || state === "refused" || state === "gone") return state;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }
  return "timeout";
}
function endpoint(directory: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\acp-${hash(directory).slice(0, 32)}`
    : join(directory, "service.sock");
}
export async function serve(harness: string, sessionId: string, cliPath?: string): Promise<void> {
  const directory = sessionDirectory(harness, sessionId),
    token = sessionToken(directory);
  let profile: Profile = strictProfile;
  let profileFailure = false;
  try {
    profile = loadProfile();
  } catch {
    profileFailure = true; // an unreadable or untrusted profile must never loosen policy
  }
  const session = new PolicySession(directory, harness, sessionId, profile, cliPath);
  const server = createServer((socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    let data = "";
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      data += chunk.toString();
      if (data.length > 1024 * 1024) {
        socket.destroy();
        return;
      }
      const end = data.indexOf("\n");
      if (end < 0) return;
      socket.pause();
      try {
        const message = JSON.parse(data.slice(0, end)) as Message;
        if (message.token !== token) throw new Error("Unauthenticated request");
        // A waiting hook polls every second: the session audits the start and end of the wait.
        if (message.action !== "await")
          audit(directory, {
            event: "request-envelope",
            payloadHash: hash(data.slice(0, end)),
            ...(message.request
              ? { requestHash: requestHash(message.request) }
              : message.classification
                ? { requestHash: message.classification.requestHash }
                : message.report
                  ? { requestHash: message.report.requestHash }
                  : message.grant
                    ? { requestHash: String(message.grant.requestHash) }
                    : {}),
            action: [
              "ping",
              "review",
              "classify",
              "record",
              "grant",
              "refuse",
              "await",
              "harness",
              "pending",
              "stop",
            ].includes(message.action)
              ? message.action
              : "invalid",
          });
        idle.refresh();
        // A review can wait for the classifier; the connection stays open until it answers.
        socket.setTimeout(REVIEW_TIMEOUT_MS + 5000);
        let result: unknown;
        if (message.action === "ping") result = { ready: true };
        else if (message.action === "pending") result = session.latestHumanDecision() ?? null;
        else if (message.action === "stop") {
          audit(directory, { event: "session-end" });
          result = { stopped: true };
          server.close();
        } else if (message.action === "review" && message.request)
          result = await session.decide(
            message.request,
            message.phase,
            typeof message.toolUseId === "string" ? message.toolUseId : undefined,
            typeof message.permissionMode === "string" ? message.permissionMode : undefined,
          );
        else if (message.action === "classify" && message.classification)
          result = session.classify(message.classification);
        else if (message.action === "record" && message.report) {
          session.record(message.report);
          const answer =
            message.phase?.startsWith("PostToolUse") && message.report.event === "execution-result"
              ? session.answered({
                  requestHash: message.report.requestHash,
                  phase: message.phase,
                  ...(typeof message.toolUseId === "string"
                    ? { toolUseId: message.toolUseId }
                    : {}),
                  ...(typeof message.failure?.error === "string"
                    ? { error: message.failure.error.slice(0, 2000) }
                    : {}),
                  ...(message.failure?.interrupted === true ? { interrupted: true } : {}),
                })
              : undefined;
          result = { recorded: true, ...(answer ? { answer } : {}) };
        } else if (message.action === "harness") {
          // With a pid, the hook reports its harness; without, `approve` asks for it.
          if (typeof message.harnessPid === "number") session.noteHarness(message.harnessPid);
          result = session.harnessPid ? { harnessPid: session.harnessPid } : {};
        } else if (message.action === "await" && message.grant)
          result =
            message.waitOutcome === "timeout"
              ? session.endWait(String(message.grant.requestHash), "timeout")
              : session.approvalState(String(message.grant.requestHash));
        else if (message.action === "refuse" && message.grant) {
          try {
            result = session.refuse(String(message.grant.requestHash));
          } catch (error) {
            if (!(error instanceof GrantError)) throw error;
            result = { refused: false };
          }
        } else if (message.action === "grant" && message.grant) {
          try {
            result = session.grant(
              String(message.grant.requestHash),
              message.grant.confirm === true,
              message.grant.session === true,
            );
          } catch (error) {
            if (!(error instanceof GrantError)) throw error;
            result = { granted: false, refused: error.message };
          }
        } else throw new Error("Invalid service request");
        socket.end(`${JSON.stringify({ result })}\n`);
      } catch {
        try {
          audit(directory, {
            event: "evaluation-failure",
            decision: "human",
            payloadHash: hash(data.slice(0, end)),
          });
        } catch {
          /* An audit failure must never produce an approval. */
        }
        socket.end(
          `${JSON.stringify({ error: "Policy evaluation failed; human approval is required" })}\n`,
        );
      }
    });
  });
  const idle = setTimeout(() => server.close(), 30 * 60 * 1000);
  server.on("close", () => clearTimeout(idle));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint(directory), () => {
      if (process.platform !== "win32") chmodSync(endpoint(directory), 0o600);
      resolve();
    });
  });
  audit(directory, {
    event: "session-start",
    harness,
    sessionHash: hash(sessionId),
  });
  audit(directory, {
    event: "profile",
    mode: profile.mode,
    status: profileFailure
      ? "invalid-using-strict"
      : profile.digest
        ? "loaded"
        : "none-using-strict",
    ...(profile.digest ? { digest: profile.digest } : {}),
  });
}
export function send(
  harness: string,
  sessionId: string,
  message: Omit<Message, "token">,
): Promise<unknown> {
  return sendTo(
    sessionDirectory(harness, sessionId),
    message,
    message.action === "review" ? REVIEW_TIMEOUT_MS : undefined,
  );
}
/**
 * The newest request waiting for a person across this user's running policy services, for
 * `approve --last`. Only private session directories owned by this user are asked.
 */
export async function latestHumanDecision(): Promise<
  | {
      directory: string;
      requestHash: string;
      at: number;
      harness: string;
      sessionId: string;
      harnessPid?: number;
    }
  | undefined
> {
  const root = tmpdir();
  const prefix = `acp-${process.getuid?.() ?? "user"}-`;
  let best:
    | {
        directory: string;
        requestHash: string;
        at: number;
        harness: string;
        sessionId: string;
        harnessPid?: number;
      }
    | undefined;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix) || !/^[a-f0-9]{24}$/.test(name.slice(prefix.length))) continue;
    const directory = join(root, name);
    try {
      const stat = lstatSync(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) ||
        !existsSync(join(directory, "token"))
      )
        continue;
      const found = (await sendTo(directory, { action: "pending" })) as {
        requestHash?: unknown;
        at?: unknown;
        harness?: unknown;
        sessionId?: unknown;
        harnessPid?: unknown;
      } | null;
      if (
        found &&
        typeof found.requestHash === "string" &&
        /^[a-f0-9]{64}$/.test(found.requestHash) &&
        typeof found.at === "number" &&
        typeof found.harness === "string" &&
        typeof found.sessionId === "string" &&
        (!best || found.at > best.at)
      )
        best = {
          directory,
          requestHash: found.requestHash,
          at: found.at,
          harness: found.harness,
          sessionId: found.sessionId,
          ...(typeof found.harnessPid === "number" ? { harnessPid: found.harnessPid } : {}),
        };
    } catch {
      /* A stopped or unreachable service has nothing to approve. */
    }
  }
  return best;
}
/**
 * The harness process of every running policy session of this user, for `approve`'s ancestry
 * check: an agent in one session must not approve another session's request either.
 */
export async function harnessPids(): Promise<number[]> {
  const found: number[] = [];
  for (const directory of sessionDirectories()) {
    try {
      const answer = (await sendTo(directory, { action: "harness" }, 1500)) as {
        harnessPid?: unknown;
      } | null;
      if (answer && typeof answer.harnessPid === "number") found.push(answer.harnessPid);
    } catch {
      /* A stopped or unreachable service has no harness running. */
    }
  }
  return found;
}

/** This user's private session directories with a token, as `approve --last` trusts them. */
function sessionDirectories(): string[] {
  const root = tmpdir();
  const prefix = `acp-${process.getuid?.() ?? "user"}-`;
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix) || !/^[a-f0-9]{24}$/.test(name.slice(prefix.length))) continue;
    const directory = join(root, name);
    try {
      const stat = lstatSync(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) ||
        !existsSync(join(directory, "token"))
      )
        continue;
      found.push(directory);
    } catch {
      /* gone */
    }
  }
  return found;
}

/** Sends to the service of an existing session directory (see `approve --last`). */
export function sendTo(
  directory: string,
  message: Omit<Message, "token">,
  timeoutMs = 4000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint(directory));
    let data = "";
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Policy service timeout")));
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ ...message, token: sessionToken(directory) })}\n`),
    );
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 1024 * 1024) socket.destroy(new Error("Oversized response"));
    });
    socket.on("end", () => {
      try {
        const response = JSON.parse(data);
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
/**
 * Stops a session's service. A session with no service (it never started, already ended, or the
 * harness fired SessionEnd outside a real session such as `claude update`) is not an error:
 * there is nothing left to stop, and no session directory is created for it. Unsafe directories
 * and other failures still throw.
 */
export async function stop(harness: string, sessionId: string): Promise<"stopped" | "not-running"> {
  if (!existsSync(sessionDirectoryPath(harness, sessionId))) return "not-running";
  try {
    await send(harness, sessionId, { action: "stop" });
    return "stopped";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return "not-running";
    throw error;
  }
}
export async function start(harness: string, sessionId: string, cliPath: string): Promise<string> {
  const directory = sessionDirectory(harness, sessionId);
  try {
    await send(harness, sessionId, { action: "ping" });
    return directory;
  } catch {
    /* Start a service if none is available. */
  }
  const child = spawn(process.execPath, [cliPath, "serve", harness, sessionId], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await send(harness, sessionId, { action: "ping" });
      return directory;
    } catch {
      /* Another start can win the socket race. */
    }
  }
  throw new Error("Policy service unavailable; human approval is required");
}
