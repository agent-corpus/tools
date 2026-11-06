import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { audit, sessionDirectory, sessionToken } from "./audit.js";
import { hash } from "./policy.js";
import { PolicySession } from "./session.js";
import type { Classification, Request } from "./types.js";

interface Message {
  token: string;
  action: "ping" | "review" | "classify" | "stop";
  request?: Request;
  classification?: Classification;
}
function endpoint(directory: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\acp-${hash(directory).slice(0, 32)}`
    : join(directory, "service.sock");
}
export async function serve(harness: string, sessionId: string): Promise<void> {
  const directory = sessionDirectory(harness, sessionId),
    token = sessionToken(directory);
  const session = new PolicySession(directory, harness, sessionId);
  const server = createServer((socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    let data = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
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
        audit(directory, {
          event: "request-envelope",
          payloadHash: hash(data.slice(0, end)),
          action: ["ping", "review", "classify", "stop"].includes(message.action)
            ? message.action
            : "invalid",
        });
        idle.refresh();
        let result: unknown;
        if (message.action === "ping") result = { ready: true };
        else if (message.action === "stop") {
          audit(directory, { event: "session-end" });
          result = { stopped: true };
          server.close();
        } else if (message.action === "review" && message.request)
          result = session.review(message.request);
        else if (message.action === "classify" && message.classification)
          result = session.classify(message.classification);
        else throw new Error("Invalid service request");
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
  audit(directory, { event: "session-start", harness, sessionHash: hash(sessionId) });
}
export function send(
  harness: string,
  sessionId: string,
  message: Omit<Message, "token">,
): Promise<unknown> {
  const directory = sessionDirectory(harness, sessionId);
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint(directory));
    let data = "";
    socket.setTimeout(4000, () => socket.destroy(new Error("Policy service timeout")));
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
