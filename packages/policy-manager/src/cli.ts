#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executionReport, hookResponse, normalize } from "./adapters.js";
import { hookConfig } from "./config.js";
import { send, serve, start } from "./service.js";
import type { Classification, Decision, OutcomeReport, Request } from "./types.js";

const usage = `policy-manager usage [--json]
policy-manager hook <claude|codex|copilot> <SessionStart|PreToolUse|PermissionRequest|PostToolUse|PostToolUseFailure|SessionEnd>
policy-manager review <claude|codex|copilot> <session-id>   # normalized request JSON on stdin
policy-manager classify <claude|codex|copilot> <session-id> # {requestHash,category,confidence} on stdin
policy-manager record <claude|codex|copilot> <session-id>   # host-reported human response or execution result JSON
policy-manager config <claude|codex|copilot> <absolute-installed-cli-path>
policy-manager stop <claude|codex|copilot> <session-id>
A per-session background service checks policy and writes private temporary audit.jsonl logs.
AI classification comes from the session's policy-manager agent, never an external API.
Unknown effects require human approval. Exit 0: protocol response; exit 1: malformed input or service failure.
`;
async function stdin(): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString();
    if (text.length > 1024 * 1024) throw new Error("Oversized request");
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
const args = process.argv.slice(2);
const [action, harnessArg, phase] = args;
const harness = harnessArg as Request["harness"];
const cliPath = fileURLToPath(import.meta.url);
try {
  if (action === "usage" || !action)
    console.log(args.includes("--json") ? JSON.stringify({ usage }) : usage);
  else if (action === "config")
    console.log(JSON.stringify(hookConfig(harness, phase ?? ""), null, 2));
  else if (action === "serve") await serve(harness, phase ?? "");
  else if (action === "stop")
    console.log(JSON.stringify(await send(harness, phase ?? "", { action: "stop" })));
  else if (action === "review" || action === "classify" || action === "record") {
    const payload = await stdin();
    await start(harness, phase ?? "", cliPath);
    const result = await send(
      harness,
      phase ?? "",
      action === "review"
        ? { action, request: payload as unknown as Request }
        : action === "classify"
          ? { action, classification: payload as unknown as Classification }
          : { action, report: payload as unknown as OutcomeReport },
    );
    console.log(JSON.stringify(result));
  } else if (action === "hook") {
    const payload = await stdin();
    const request = normalize(harness, payload);
    if (phase === "SessionEnd") {
      await send(harness, request.sessionId, { action: "stop" });
      console.log("{}");
    } else {
      const directory = await start(harness, request.sessionId, cliPath);
      if (phase === "SessionStart") {
        const context = `Policy service started. Audit log: ${join(directory, "audit.jsonl")}. Read .agent-config/agents/policy-manager.md and create one read-only policy-manager agent for this session. Use it only for ambiguous requests. Never ask it to approve its own tools.`;
        console.log(
          JSON.stringify(
            harness === "copilot"
              ? { additionalContext: context }
              : { hookSpecificOutput: { hookEventName: phase, additionalContext: context } },
          ),
        );
      } else if (phase === "PostToolUse" || phase === "PostToolUseFailure") {
        await send(harness, request.sessionId, {
          action: "record",
          report: executionReport(request, phase, payload),
        });
        console.log("{}");
      } else if (phase === "PreToolUse" || phase === "PermissionRequest") {
        const decision = (await send(harness, request.sessionId, {
          action: "review",
          request,
        })) as Decision;
        console.log(JSON.stringify(hookResponse(harness, phase, decision)));
      } else throw new Error("Unsupported hook event");
    }
  } else throw new Error(usage);
} catch {
  if (action === "record" || (action === "hook" && phase?.startsWith("PostToolUse"))) {
    console.error("The audit report could not be recorded. The tool may already have completed.");
    process.exitCode = 1;
  } else {
    // Error text can contain paths or secrets. Keep diagnostics fixed.
    console.error(
      "Policy manager failed. Human approval is required. No automatic approval was granted.",
    );
    if (action === "hook" && phase === "PermissionRequest") console.log("{}");
    else if (action === "hook" && phase === "PreToolUse") {
      console.error("The policy check could not complete.");
      process.exitCode = 2;
    } else process.exitCode = 1;
  }
}
