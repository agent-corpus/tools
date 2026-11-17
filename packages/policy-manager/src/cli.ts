#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { executionReport, type HookContext, hookOutput, normalize } from "./adapters.js";
import { harnessOf, insideAgent, processTable } from "./ancestry.js";
import {
  type ApproveScope,
  approvedMessage,
  approveQuestion,
  describeRequest,
  ONCE_ONLY_NOTE,
  parseAnswer,
} from "./approve.js";
import { sessionDirectoryPath } from "./audit.js";
import { CLASSIFIER_ENV } from "./classifier.js";
import {
  DEFAULT_APPROVAL_WAIT_SECONDS,
  hookConfig,
  MAX_APPROVAL_WAIT_SECONDS,
  WAIT_FLAG,
} from "./config.js";
import { HUMAN_ONLY_FOR } from "./principle.js";
import { defaultProfilePath, loadProfile, parseProfile } from "./profile.js";
import { replayClassified, replayTranscripts } from "./replay.js";
import { formatReview, reviewClassifications, sessionDirectories } from "./review.js";
import {
  harnessPids,
  latestHumanDecision,
  send,
  sendTo,
  serve,
  start,
  stop,
  waitForApproval,
} from "./service.js";
import type { GrantPreview } from "./session.js";
import { SetupError, setupHook } from "./setup.js";
import { cliVersion, inspectShim, shimDirectory } from "./shim.js";
import type { Classification, Decision, OutcomeReport, Request } from "./types.js";

const usage = `policy-manager usage [--json]
policy-manager hook <claude|codex|copilot> <SessionStart|PreToolUse|PermissionRequest|PostToolUse|PostToolUseFailure|SessionEnd>
policy-manager review <claude|codex|copilot> <session-id>   # normalized request JSON on stdin
policy-manager classify <claude|codex|copilot> <session-id> # {requestHash,category,confidence} on stdin
policy-manager record <claude|codex|copilot> <session-id>   # host-reported human response or execution result JSON
policy-manager approve --last [--once|--session]  # the user, in their own terminal: shows the newest blocked request and asks "just this once, or for this session?"; a flag answers in advance
policy-manager approve <claude|codex|copilot> <session-id> <request-hash> [--once|--session]  # the same for one exact request
policy-manager setup-hook <claude|codex|copilot> [--dry-run] [--config-dir <harness-config-directory>] [--shim-dir <directory>] [--approval-wait <seconds>]
policy-manager setup-hook-claude|setup-hook-codex|setup-hook-copilot [--dry-run] [--config-dir <directory>] [--shim-dir <directory>] [--approval-wait <seconds>]
  --approval-wait: Codex only. How long PreToolUse waits for your approval (default ${DEFAULT_APPROVAL_WAIT_SECONDS}, at most ${MAX_APPROVAL_WAIT_SECONDS}; 0 denies at once). Its hook timeout is set to match.
policy-manager config <claude|codex|copilot> <absolute-installed-cli-path>
policy-manager profile validate <file>   # check a policy profile without installing it
policy-manager profile install <file>    # install it to the user config directory outside Git
policy-manager replay <transcript-dir-or-file...> [--profile <file>] [--files <n>] [--classify [--limit <n>] [--json]]  # approval rate over recorded Bash commands; --classify runs the real AI classifier on the newest escalations; nothing is executed
policy-manager review-classifications [--since <iso-time>] [--dir <session-dir>...] [--json]  # risk review of AI-classified ambiguous requests
policy-manager stop <claude|codex|copilot> <session-id>
A per-session background service checks policy and writes private temporary audit.jsonl logs.
What the engine cannot approve is classified by the harness CLI the user is logged in to (claude, codex or copilot), run inside the hook.
Unknown effects require human approval. Exit 0: protocol response; exit 1: malformed input or service failure.
`;
/** An `approve` failure whose message is meant for the user. */
class ApproveError extends Error {}
type GrantResult = Partial<GrantPreview> & {
  granted: boolean;
  waiting?: boolean;
  harnessPid?: number;
  scope?: "once" | "session";
  refused?: string;
};
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
/**
 * Seconds this hook may wait for an approval: the value setup wrote after WAIT_FLAG, which it
 * matched with the hook's timeout. A hook with none (an older setup) does not wait.
 */
function approvalWait(argv: string[]): number {
  const index = argv.indexOf(WAIT_FLAG);
  if (index < 0) return 0;
  const value = Number(argv[index + 1]);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_APPROVAL_WAIT_SECONDS ? value : 0;
}
/** Whether a managed `pm` launcher for this CLI is installed and on PATH. */
function pmReady(): boolean {
  try {
    const status = inspectShim(shimDirectory(), cliPath, cliVersion(cliPath));
    return status.state === "current" && status.onPath;
  } catch {
    return false;
  }
}
try {
  if (action === "usage" || !action)
    console.log(args.includes("--json") ? JSON.stringify({ usage }) : usage);
  else if (action === "setup-hook" || /^setup-hook-(claude|codex|copilot)$/.test(action)) {
    const alias = action.match(/^setup-hook-(claude|codex|copilot)$/)?.[1];
    const selected = (alias ?? harnessArg) as Request["harness"];
    const { values } = parseArgs({
      args: args.slice(alias ? 1 : 2),
      options: {
        "dry-run": { type: "boolean" },
        "config-dir": { type: "string" },
        "shim-dir": { type: "string" },
        "approval-wait": { type: "string" },
      },
    });
    const wait = values["approval-wait"];
    if (wait !== undefined && !/^\d+$/.test(wait))
      throw new SetupError("--approval-wait takes a number of seconds.");
    console.log(
      JSON.stringify(
        setupHook(selected, cliPath, {
          dryRun: values["dry-run"],
          configDirectory: values["config-dir"],
          shimDirectory: values["shim-dir"],
          ...(wait === undefined ? {} : { approvalWaitSeconds: Number(wait) }),
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
      toolsDeny: Object.values(profile.toolsDeny).reduce((n, list) => n + list.length, 0),
      classifier: profile.classifier,
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
      options: {
        profile: { type: "string" },
        files: { type: "string" },
        classify: { type: "boolean" },
        limit: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const profile = values.profile
      ? parseProfile(readFileSync(values.profile, "utf8"))
      : loadProfile();
    if (values.classify) {
      const report = await replayClassified(positionals, profile, {
        limit: Number(values.limit ?? 300),
        files: Number(values.files ?? 200),
        concurrency: 4,
      });
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(
          `${report.commands} unique commands read; engine approved ${report.engineApproved}; ${report.escalations} escalations replayed`,
        );
        console.log(
          `AI approved ${report.aiApproved}; user allow rule approved ${report.userAllowApproved}; user deny/ask rule (left to the harness) ${report.userRuleNative}; other no-decision ${report.otherNative}; still ask ${report.stillAsk}`,
        );
        console.log(
          `classifier runs ${report.classifierRuns}; errors ${JSON.stringify(report.classifierErrors)}; latency p50 ${report.latencyMs.p50} ms, p95 ${report.latencyMs.p95} ms, max ${report.latencyMs.max} ms`,
        );
        for (const row of report.askReasons.slice(0, 15)) {
          console.log(`${row.count}\t${row.reason}`);
          for (const example of row.examples) console.log(`\t  ${example}`);
        }
      }
      process.exit(0);
    }
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
  } else if (action === "approve") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: {
        session: { type: "boolean" },
        once: { type: "boolean" },
        last: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const usageText =
      "Usage: policy-manager approve --last [--once|--session], or approve <claude|codex|copilot> <session-id> <request-hash> [--once|--session]";
    if (values.session && values.once) throw new ApproveError(usageText);
    let directory: string;
    let requestHash: string;
    let session: { harness: string; sessionId: string; harnessPid?: number };
    if (values.last) {
      if (positionals.length) throw new ApproveError(usageText);
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new ApproveError(
          "Run approve yourself in an interactive terminal; it asks you to confirm the request.",
        );
      const latest = await latestHumanDecision();
      if (!latest)
        throw new ApproveError(
          "No running policy session has a request waiting for approval from the last 15 minutes. Have the agent retry so it is blocked again.",
        );
      ({ directory, requestHash } = latest);
      session = latest;
    } else {
      const [target, sessionId, hashArg] = positionals as [Request["harness"], string, string];
      if (
        !["claude", "codex", "copilot"].includes(target) ||
        !/^[A-Za-z0-9_.-]+$/.test(sessionId ?? "") ||
        !/^[a-f0-9]{64}$/.test(hashArg ?? "")
      )
        throw new ApproveError(usageText);
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new ApproveError(
          "Run approve yourself in an interactive terminal; it asks you to confirm the request.",
        );
      if (!existsSync(sessionDirectoryPath(target, sessionId)))
        throw new ApproveError("No policy service is running for that session.");
      directory = sessionDirectoryPath(target, sessionId);
      requestHash = hashArg;
      session = { harness: target, sessionId };
    }
    const ask = (confirm: boolean, scope: ApproveScope) =>
      sendTo(directory, {
        action: "grant",
        grant: { requestHash, confirm, session: scope === "session" },
      }) as Promise<GrantResult>;
    // A session preview: its scope says whether the request can be approved for the session.
    const preview = await ask(false, "session");
    if (preview.refused) throw new ApproveError(preview.refused);
    // A terminal below the agent harness (a PTY from the agent, `script`) is the agent's, not
    // the user's: refuse before showing or granting anything.
    const pids = [...(await harnessPids())];
    for (const pid of [session.harnessPid, preview.harnessPid]) if (pid) pids.push(pid);
    const inside = insideAgent(pids);
    if (inside) throw new ApproveError(inside);
    const grantable = preview.scope === "session";
    for (const line of describeRequest(preview, session)) console.log(line);
    let scope: ApproveScope | undefined = values.once
      ? "once"
      : values.session && grantable
        ? "session"
        : undefined;
    if (values.session && !grantable) console.log(ONCE_ONLY_NOTE);
    if (!scope) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question(approveQuestion(grantable));
      prompt.close();
      scope = parseAnswer(answer, grantable);
    }
    if (!scope) {
      // Tell the service, so a hook waiting for this request stops and denies it.
      await sendTo(directory, {
        action: "refuse",
        grant: { requestHash, confirm: false },
      }).catch(() => undefined);
      throw new ApproveError("Not approved.");
    }
    const granted = await ask(true, scope);
    if (!granted.granted) throw new ApproveError(granted.refused ?? "Not approved.");
    console.log(approvedMessage(granted.scope ?? scope, granted.waiting === true));
  } else if (action === "serve") await serve(harness, phase ?? "", cliPath);
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
    const toolUseId = payload.tool_use_id ?? payload.toolUseId;
    if (process.env[CLASSIFIER_ENV] === "1") {
      // Inside the classifier's own CLI run, which has no tools and no hooks: refuse anything that
      // still reaches a policy hook, and start no service.
      if (phase === "PreToolUse")
        console.log(
          hookOutput(harness, phase, {
            decision: "deny",
            category: "unknown",
            reason: "The policy classifier runs without tools",
            requestHash: "",
            cache: "none",
            cached: false,
          }),
        );
      else console.log(harness === "codex" ? "" : "{}");
    } else if (phase === "SessionEnd") {
      await stop(harness, request.sessionId);
      console.log("{}");
    } else {
      const directory = await start(harness, request.sessionId, cliPath);
      if (phase === "SessionStart") {
        const context = `Policy service started. Audit log: ${join(directory, "audit.jsonl")}. Tool requests are checked by a deterministic policy engine; what it cannot approve is classified by an AI model through the user's own logged-in CLI, inside the hook. What neither approves goes to the user${harness === "codex" ? ", who approves it from their own terminal" : " in the normal permission prompt"}. A person is needed only for ${HUMAN_ONLY_FOR}. Never ask an agent to approve its own tools.`;
        console.log(
          JSON.stringify(
            harness === "copilot"
              ? { additionalContext: context }
              : {
                  hookSpecificOutput: {
                    hookEventName: phase,
                    additionalContext: context,
                  },
                },
          ),
        );
      } else if (phase === "PostToolUse" || phase === "PostToolUseFailure") {
        const error = payload.error ?? payload.tool_error;
        await send(harness, request.sessionId, {
          action: "record",
          report: executionReport(request, phase, payload),
          phase,
          ...(typeof toolUseId === "string" ? { toolUseId } : {}),
          ...(phase === "PostToolUseFailure"
            ? {
                failure: {
                  ...(typeof error === "string" ? { error } : {}),
                  interrupted: payload.is_interrupt === true,
                },
              }
            : {}),
        });
        console.log("{}");
      } else if (phase === "PreToolUse" || phase === "PermissionRequest") {
        // The wait is measured from this process's start, so service start-up counts too.
        const started = Math.floor(performance.timeOrigin);
        const review = () =>
          send(harness, request.sessionId, {
            action: "review",
            request,
            phase,
            ...(typeof toolUseId === "string" ? { toolUseId } : {}),
            ...(typeof payload.permission_mode === "string"
              ? { permissionMode: payload.permission_mode }
              : {}),
          }) as Promise<Decision>;
        let decision = await review();
        // Tell the service which process this session's harness is, so `approve` can refuse to
        // run below it. Only for a decision a person must make: reading the process table costs.
        if (decision.decision === "human") {
          // Best effort and bounded: the hook's own timeout must still cover the review.
          const table = processTable(3_000);
          const harnessPid = table && harnessOf(process.pid, table);
          if (harnessPid)
            await send(harness, request.sessionId, { action: "harness", harnessPid }).catch(
              () => undefined,
            );
        }
        let waited: HookContext["waited"];
        // Codex cannot ask: a request that needs a person waits here for the user's approval
        // from their own terminal, when setup gave this hook a wait and a matching timeout.
        const wait = approvalWait(args);
        if (
          harness === "codex" &&
          phase === "PreToolUse" &&
          wait > 0 &&
          decision.decision === "human" &&
          !decision.userOnly
        ) {
          const requestHash = decision.requestHash;
          const outcome = await waitForApproval(
            () =>
              send(harness, request.sessionId, {
                action: "await",
                grant: { requestHash, confirm: false },
              }),
            started + wait * 1000,
          );
          if (outcome === "granted") decision = await review();
          else {
            waited = { seconds: wait, outcome };
            if (outcome === "timeout")
              await send(harness, request.sessionId, {
                action: "await",
                grant: { requestHash, confirm: false },
                waitOutcome: "timeout",
              }).catch(() => undefined);
          }
        }
        const output = hookOutput(harness, phase, decision, {
          cliPath,
          sessionId: request.sessionId,
          pmOnPath: decision.decision === "human" && harness === "codex" && pmReady(),
          ...(waited ? { waited } : {}),
        });
        if (output) console.log(output);
      } else throw new Error("Unsupported hook event");
    }
  } else throw new Error(usage);
} catch (error) {
  if (error instanceof ApproveError) {
    console.error(error.message);
    process.exitCode = 1;
  } else if (action === "approve") {
    console.error("The approval could not be recorded. Nothing was approved.");
    process.exitCode = 1;
  } else if (action?.startsWith("setup-hook")) {
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
