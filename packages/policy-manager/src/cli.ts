#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { executionReport, hookResponse, normalize } from "./adapters.js";
import { hookConfig } from "./config.js";
import { APPROVAL_PRINCIPLE } from "./principle.js";
import { defaultProfilePath, loadProfile, parseProfile } from "./profile.js";
import { replayTranscripts } from "./replay.js";
import { formatReview, reviewClassifications, sessionDirectories } from "./review.js";
import { send, serve, start, stop } from "./service.js";
import { SetupError, setupHook } from "./setup.js";
import type { Classification, Decision, OutcomeReport, Request } from "./types.js";

const usage = `policy-manager usage [--json]
policy-manager hook <claude|codex|copilot> <SessionStart|PreToolUse|PermissionRequest|PostToolUse|PostToolUseFailure|SessionEnd>
policy-manager review <claude|codex|copilot> <session-id>   # normalized request JSON on stdin
policy-manager classify <claude|codex|copilot> <session-id> # {requestHash,category,confidence} on stdin
policy-manager record <claude|codex|copilot> <session-id>   # host-reported human response or execution result JSON
policy-manager setup-hook <claude|codex|copilot> [--dry-run] [--config-dir <harness-config-directory>]
policy-manager setup-hook-claude|setup-hook-codex|setup-hook-copilot [--dry-run] [--config-dir <directory>]
policy-manager config <claude|codex|copilot> <absolute-installed-cli-path>
policy-manager profile validate <file>   # check a policy profile without installing it
policy-manager profile install <file>    # install it to the user config directory outside Git
policy-manager replay <transcript-dir-or-file...> [--profile <file>] [--files <n>]  # approval rate over recorded Bash commands; nothing is executed
policy-manager review-classifications [--since <iso-time>] [--dir <session-dir>...] [--json]  # risk review of AI-classified ambiguous requests
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
  else if (action === "setup-hook" || /^setup-hook-(claude|codex|copilot)$/.test(action)) {
    const alias = action.match(/^setup-hook-(claude|codex|copilot)$/)?.[1];
    const selected = (alias ?? harnessArg) as Request["harness"];
    const { values } = parseArgs({
      args: args.slice(alias ? 1 : 2),
      options: { "dry-run": { type: "boolean" }, "config-dir": { type: "string" } },
    });
    console.log(
      JSON.stringify(
        setupHook(selected, cliPath, {
          dryRun: values["dry-run"],
          configDirectory: values["config-dir"],
        }),
        null,
        2,
      ),
    );
  } else if (action === "config")
    console.log(JSON.stringify(hookConfig(harness, phase ?? ""), null, 2));
  else if (
    action === "profile" &&
    (harnessArg === "validate" || harnessArg === "install") &&
    phase
  ) {
    const profile = parseProfile(readFileSync(phase, "utf8"));
    const summary = {
      mode: profile.mode,
      cloudWrites: profile.cloudWrites,
      mcpReadOnly: profile.mcpReadOnly.length,
      digest: profile.digest,
    };
    if (harnessArg === "install") {
      const target = defaultProfilePath();
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, readFileSync(phase, "utf8"), { mode: 0o600 });
      renameSync(temporary, target);
      console.log(JSON.stringify({ installed: target, ...summary }));
    } else console.log(JSON.stringify({ valid: true, ...summary }));
  } else if (action === "replay") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: { profile: { type: "string" }, files: { type: "string" } },
      allowPositionals: true,
    });
    const profile = values.profile
      ? parseProfile(readFileSync(values.profile, "utf8"))
      : loadProfile();
    const report = replayTranscripts(positionals, profile, Number(values.files ?? 50));
    const pct = (n: number) => `${((100 * n) / Math.max(report.commands, 1)).toFixed(1)}%`;
    console.log(
      `${report.commands} unique commands; approved ${pct(report.approved)} (strict ${pct(report.strictApproved)})`,
    );
    const humans = report.commands - report.approved;
    console.log(
      `${report.classified} of ${humans} escalations go to AI classification instead of a person; ${humans - report.classified} stay with a human by rule`,
    );
    for (const row of report.reasons.slice(0, 15)) {
      console.log(`${row.count}\t${row.reason}`);
      for (const example of row.examples) console.log(`\t  ${example}`);
    }
  } else if (action === "review-classifications") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        since: { type: "string" },
        dir: { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    });
    const review = await reviewClassifications(sessionDirectories(values.dir ?? []), values.since);
    console.log(values.json ? JSON.stringify(review, null, 2) : formatReview(review));
  } else if (action === "serve") await serve(harness, phase ?? "");
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
      await stop(harness, request.sessionId);
      console.log("{}");
    } else {
      const directory = await start(harness, request.sessionId, cliPath);
      if (phase === "SessionStart") {
        const context = `Policy service started. Audit log: ${join(directory, "audit.jsonl")}. Native hooks route tool and permission requests directly to the deterministic service. An ambiguous request is blocked once with instructions to have the policy-manager agent classify it and then retry; the person is asked only if classification fails. ${APPROVAL_PRINCIPLE} If .agent-config/agents/policy-manager.md exists, read it before creating a read-only policy-manager agent. Never ask an agent to approve its own tools.`;
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
          phase,
        })) as Decision;
        console.log(
          JSON.stringify(
            hookResponse(harness, phase, decision, { cliPath, sessionId: request.sessionId }),
          ),
        );
      } else throw new Error("Unsupported hook event");
    }
  } else throw new Error(usage);
} catch (error) {
  if (action?.startsWith("setup-hook")) {
    console.error(
      error instanceof SetupError
        ? error.message
        : "Hook setup failed. No automatic approval was granted.",
    );
    process.exitCode = 1;
  } else if (action === "record" || (action === "hook" && phase?.startsWith("PostToolUse"))) {
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
