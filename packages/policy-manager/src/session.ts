import { basename, dirname } from "node:path";
import { looksLikeApproveGrant, looksLikeClassifyRecord } from "./adapters.js";
import { audit, requestSummary } from "./audit.js";
import { type ClassifierResult, classifyWithCli } from "./classifier.js";
import {
  type CreatedFiles,
  creationTargets,
  located,
  pathKey,
  settle,
  stamp,
  type Target,
  withCreated,
} from "./created.js";
import { grantScope, scopeLabel } from "./grants.js";
import { APPROVE_GUARD, hardRules } from "./hard.js";
import { type NativeMatch, nativeRules } from "./nativerules.js";
import { evaluate, hash, requestHash as requestHashOf, result, SHELL_TOOLS } from "./policy.js";
import { type Profile, strictProfile } from "./profile.js";
import { buildPrompt } from "./prompt.js";
import { redactText } from "./redact.js";
import {
  CATEGORIES,
  type Classification,
  type Decision,
  type OutcomeReport,
  type Request,
} from "./types.js";

/** How long a classification verdict for one exact request (tool, input and cwd) is reused. */
const CLASSIFICATION_TTL_MS = 5 * 60_000;
/** How long after its approval an execution report may still record the files a tool created. */
const CREATION_REPORT_MS = 15 * 60_000;

export { APPROVE_GUARD };

/** Claude Code permission modes in which a hook's ask is shown to a person. */
const PROMPTING_MODES = new Set(["default", "acceptEdits", "plan"]);
/** Hard items no allow rule approves, at any level: they always ask the person. */
const NO_ALLOW = new Set([
  "credential-read",
  "harness-settings",
  "policy-profile",
  "policy-state",
  "force-push",
]);
/** How long after a human decision the user may still approve that exact request once. */
export const GRANT_WINDOW_MS = 15 * 60_000;
/** How long a harness prompt may stay open and still have its answer remembered. */
const ASK_WINDOW_MS = 60 * 60_000;
/** A failed tool whose error says the user turned it down: that is not a "yes". */
const REJECTED =
  /doesn't want to proceed|does not want to proceed|rejected|denied|declined|not approved|permission/i;

/** What `approve` shows the user before a one-time grant: the request a person must decide. */
export interface GrantPreview {
  requestHash: string;
  tool: string;
  category: Decision["category"];
  reason: string;
  /** Redacted command or target, for the user to recognize the request. */
  detail: string;
  /** What a session approval would cover, when this request can be approved for the session. */
  sessionScope?: string;
}

interface ClassificationState {
  expires: number;
  /** The request was recorded as entering classification. */
  requested?: boolean;
  invalid: boolean;
  /** The classifier failed for this request; a person decides it without another run. */
  fallback: boolean;
  fallbackReason?: Decision["fallbackReason"];
  ai?: Classification;
}

/** What the session runs to classify and to read the user's own rules. Replaceable in tests. */
export interface SessionDependencies {
  classify?: (
    cli: Request["harness"],
    prompt: string | undefined,
    profile: Profile,
  ) => Promise<ClassifierResult>;
  nativeRules?: (request: Request) => NativeMatch | undefined;
}

/** A tool-execution report from PostToolUse or PostToolUseFailure, for a pending harness prompt. */
export interface AskReport {
  requestHash: string;
  phase: string;
  /** Claude Code's `tool_use_id`. Copilot sends none, so its prompts are matched by request. */
  toolUseId?: string;
  /** The failure text of a PostToolUseFailure, used only to tell a rejection from a run. */
  error?: string;
  interrupted?: boolean;
}

/** A grant the service refuses; its message is safe to show the user. */
export class GrantError extends Error {}
function grantDetail(request: Request): string {
  const command = request.input.command ?? request.input.cmd;
  if (typeof command === "string") return redactText(command, 300);
  const file = request.input.file_path ?? request.input.path;
  if (typeof file === "string") return redactText(file, 300);
  if (typeof request.input.patch === "string" || typeof request.input.input === "string")
    return redactText(
      String(request.input.patch ?? request.input.input)
        .split("\n")
        .filter((line) => /^\*\*\* (?:Add|Update|Delete) File:/.test(line))
        .join("; "),
      300,
    );
  return request.tool;
}
export class PolicySession {
  private cache = new Map<string, { expires: number; ai?: Classification }>();
  private pending = new Map<string, Request>();
  private states = new Map<string, ClassificationState>();
  /** Files this session created, and the paths each approved request may create. */
  private created: CreatedFiles = new Map();
  private creating = new Map<string, { targets: Target[]; approvedAt: number }>();
  /** Requests this session sent to a person, which the user may approve once. */
  private humanDecisions = new Map<string, GrantPreview & { at: number; sessionScope?: string }>();
  /** One-time user approvals, each usable once per hook phase. */
  private grants = new Map<string, { phases: Set<string> }>();
  /** Session grants: hashes of a human rule and the scope the user approved it for. */
  private sessionGrants = new Set<string>();
  /** Harness prompts waiting for their answer, by `tool_use_id` (or `request:<hash>`). */
  private asks = new Map<string, { request: Request; decision: Decision; at: number }>();
  /** Classifications running now, so concurrent hooks for one request share one CLI run. */
  private running = new Map<string, Promise<ClassifierResult>>();
  /** The classifier CLI is not installed: later requests go straight to a person. */
  private classifierMissing = false;
  private readonly deps: Required<SessionDependencies>;
  constructor(
    readonly directory: string,
    readonly harness: string,
    readonly sessionId: string,
    readonly profile: Profile = strictProfile,
    /** This package's `cli.js`: the path in the record command the hook gives the model. */
    readonly cliPath?: string,
    deps: SessionDependencies = {},
  ) {
    this.deps = {
      classify:
        deps.classify ??
        ((cli, prompt, profile) => classifyWithCli(cli, prompt, profile.classifier)),
      nativeRules: deps.nativeRules ?? nativeRules,
    };
  }
  /**
   * A command that runs a policy-manager `classify` record goes to a person: the hook classifies
   * requests itself, and an agent that could record its own verdict could approve itself.
   */
  private classifyRecord(request: Request): Decision | undefined {
    const input = request.input;
    const command = input.command ?? input.cmd;
    if (
      !SHELL_TOOLS.has(request.tool) ||
      typeof command !== "string" ||
      !looksLikeClassifyRecord(command)
    )
      return undefined;
    return {
      ...result(
        request,
        "unknown",
        "A classification record requires human review: the hook classifies requests itself",
      ),
      hard: "foreign-classification-record",
    };
  }
  /**
   * Only the user approves a request once, from their own terminal. A shell command that runs a
   * policy-manager `approve`, in any form or nesting, is never approved for the agent.
   */
  private approveGrant(request: Request): Decision | undefined {
    const command = request.input.command ?? request.input.cmd;
    if (!SHELL_TOOLS.has(request.tool) || typeof command !== "string") return undefined;
    if (!looksLikeApproveGrant(command)) return undefined;
    return { ...result(request, "sensitive", APPROVE_GUARD), hard: "self-approve" };
  }
  /**
   * A user approval that covers this human decision: a one-time grant for this exact request
   * (used once per hook phase), or a session grant for its rule and scope. Each use is audited.
   */
  private granted(request: Request, decision: Decision, phase?: string): Decision | undefined {
    const once = this.grants.get(decision.requestHash);
    const slot = phase ?? "review";
    if (once && !once.phases.has(slot)) {
      once.phases.add(slot);
      // PreToolUse runs before PermissionRequest; once both have allowed the tool, it is spent.
      if (once.phases.has("PreToolUse") && once.phases.has("PermissionRequest"))
        this.grants.delete(decision.requestHash);
      audit(this.directory, {
        event: "human-grant-use",
        requestHash: decision.requestHash,
        scope: "once",
        phase: slot,
      });
      return {
        ...result(request, decision.category, "Approved once by the user", true),
      };
    }
    const scope = grantScope(request, decision, this.profile);
    if (scope === undefined) return undefined;
    const key = hash([decision.reason, scope]);
    if (!this.sessionGrants.has(key)) return undefined;
    audit(this.directory, {
      event: "human-grant-use",
      requestHash: decision.requestHash,
      scope: "session",
      scopeHash: key,
      phase: slot,
    });
    return {
      ...result(request, decision.category, "Approved for this session by the user", true),
    };
  }
  /** The newest request this session sent to a person that the user may still approve. */
  latestHumanDecision():
    | { requestHash: string; at: number; harness: string; sessionId: string }
    | undefined {
    let latest: { requestHash: string; at: number } | undefined;
    for (const [requestHash, entry] of this.humanDecisions)
      if (Date.now() - entry.at <= GRANT_WINDOW_MS && (!latest || entry.at >= latest.at))
        latest = { requestHash, at: entry.at };
    return latest && { ...latest, harness: this.harness, sessionId: this.sessionId };
  }
  private addSessionGrant(reason: string, scope: string): string {
    if (this.sessionGrants.size >= 64) this.sessionGrants.clear();
    const key = hash([reason, scope]);
    this.sessionGrants.add(key);
    return key;
  }
  /**
   * Looks up, and with `confirm` grants, a user approval of a request this session sent to a
   * person within the last GRANT_WINDOW_MS. Without `session` the next review of that exact
   * request is approved once per hook phase; with it, every later request in this session that
   * hits the same rule for the same scope is approved. A request with no session scope (credential
   * reads, possible unrecoverable loss) is approved once only, and the result says so.
   */
  grant(
    requestHash: string,
    confirm: boolean,
    session = false,
  ): GrantPreview & { granted: boolean; scope: "once" | "session" } {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new GrantError("Not a request hash");
    const pending = this.humanDecisions.get(requestHash);
    if (!pending || Date.now() - pending.at > GRANT_WINDOW_MS) {
      this.humanDecisions.delete(requestHash);
      throw new GrantError(
        "No request in this session needed a person with that hash in the last 15 minutes. Retry the request so it is blocked again, then approve the new hash.",
      );
    }
    const { at: _at, sessionScope, ...rest } = pending;
    const scope = session && sessionScope !== undefined ? "session" : "once";
    const preview: GrantPreview = {
      ...rest,
      ...(scope === "session" && sessionScope !== undefined
        ? { sessionScope: scopeLabel(sessionScope, this.profile) }
        : {}),
    };
    if (!confirm) return { ...preview, granted: false, scope };
    this.humanDecisions.delete(requestHash);
    if (scope === "session" && sessionScope !== undefined)
      this.addSessionGrant(preview.reason, sessionScope);
    if (this.grants.size >= 64) this.grants.delete(this.grants.keys().next().value ?? "");
    this.grants.set(requestHash, { phases: new Set() });
    audit(this.directory, {
      event: "human-grant",
      requestHash,
      category: preview.category,
      scope,
      ...(scope === "session" ? { scopeHash: hash([preview.reason, sessionScope]) } : {}),
      summary:
        scope === "session"
          ? "User approved the rule for this session"
          : "User approved the request once",
    });
    audit(this.directory, {
      event: "human-response",
      requestHash,
      response: "approved",
      summary: "User approved the request from the terminal",
    });
    return { ...preview, granted: true, scope };
  }
  private state(requestHash: string): ClassificationState | undefined {
    const state = this.states.get(requestHash);
    if (state && state.expires <= Date.now()) {
      this.states.delete(requestHash);
      return undefined;
    }
    return state;
  }
  private remember(requestHash: string, change: Partial<ClassificationState>): void {
    if (this.states.size >= 512) this.states.clear();
    this.states.set(requestHash, {
      invalid: false,
      fallback: false,
      ...this.states.get(requestHash),
      ...change,
      expires: Date.now() + CLASSIFICATION_TTL_MS,
    });
  }
  /**
   * The deterministic decision for a request, with any classification this session already has
   * for it and the user's own grants applied. Synchronous: it never runs the classifier. A request
   * that still needs one comes back `human` with `needsClassification`; `decide` runs it.
   */
  review(request: Request, ai?: Classification, phase?: string): Decision {
    return this.conclude(request, this.judge(request, ai, phase), ai);
  }
  private judge(
    request: Request,
    ai: Classification | undefined,
    phase?: string,
    /** The request was already recorded by this hook call. */
    again = false,
  ): Decision {
    if (request.sessionId !== this.sessionId || request.harness !== this.harness)
      throw new Error("Session mismatch");
    if (!again) audit(this.directory, { event: "request", ...requestSummary(request) });
    if (
      ai &&
      (!(CATEGORIES as readonly string[]).includes(ai.category) ||
        typeof ai.confidence !== "number" ||
        !Number.isFinite(ai.confidence) ||
        (ai.recoverable !== undefined && typeof ai.recoverable !== "boolean") ||
        (ai.rationale !== undefined && typeof ai.rationale !== "string") ||
        !/^[a-f0-9]{64}$/.test(ai.requestHash))
    ) {
      audit(this.directory, {
        event: "decision",
        decision: "human",
        category: "unknown",
        reason: "Malformed AI classification",
        requestHash: requestHashOf(request),
      });
      throw new Error("Malformed AI classification");
    }
    const entry = this.cache.get(this.cacheKey(request));
    const cachedAi = entry && entry.expires > Date.now() ? entry.ai : undefined;
    const requestHash = requestHashOf(request);
    const known = ai ? undefined : this.state(requestHash);
    if (ai)
      audit(this.directory, {
        event: "classification",
        requestHash,
        category: ai.category,
        confidence: ai.confidence,
        ...(ai.recoverable === undefined ? {} : { recoverable: ai.recoverable }),
        ...(ai.rationale ? { rationale: redactText(ai.rationale, 200) } : {}),
      });
    let decision =
      this.approveGrant(request) ??
      this.classifyRecord(request) ??
      withCreated(this.created, () => evaluate(request, ai ?? cachedAi ?? known?.ai, this.profile));
    if (decision.tier === "ambiguous") {
      if (ai && !decision.classification) this.remember(requestHash, { invalid: true });
      else if (ai) this.remember(requestHash, { ai });
      else if (known?.fallback || known?.invalid) {
        // Classified before without an answer that counts: a person decides, without a new run.
        decision = {
          ...decision,
          needsClassification: false,
          classification: "fallback",
          fallbackReason: known.invalid
            ? "invalid-result"
            : (known.fallbackReason ?? "unavailable"),
        };
      }
    }
    if (decision.decision === "human") {
      const allowed = this.granted(request, decision, phase);
      if (allowed) decision = allowed;
    }
    return decision;
  }
  private cacheKey(request: Request): string {
    return hash([requestHashOf(request), "policy-v1", this.profile.digest ?? this.profile.mode]);
  }
  /** Records a final decision: the person's queue, caches, pending creations and the audit log. */
  private conclude(request: Request, input: Decision, ai?: Classification): Decision {
    let decision = input;
    const key = this.cacheKey(request);
    const entry = this.cache.get(key);
    const requestHash = decision.requestHash;
    if (decision.decision === "human" && decision.reason === APPROVE_GUARD) {
      this.cache.delete(key);
      decision = { ...decision, userOnly: true, sessionGrantable: false };
    } else if (decision.decision === "human") {
      this.cache.delete(key);
      const sessionScope = grantScope(request, decision, this.profile);
      decision = {
        ...decision,
        sessionGrantable: sessionScope !== undefined,
        ...(sessionScope === undefined
          ? {}
          : { sessionScopeLabel: scopeLabel(sessionScope, this.profile) }),
      };
      if (this.humanDecisions.size >= 256)
        this.humanDecisions.delete(this.humanDecisions.keys().next().value ?? "");
      this.humanDecisions.delete(requestHash);
      this.humanDecisions.set(requestHash, {
        requestHash,
        tool: request.tool,
        category: decision.category,
        reason: decision.reason,
        detail: grantDetail(request),
        at: Date.now(),
        ...(sessionScope === undefined ? {} : { sessionScope }),
      });
    } else this.humanDecisions.delete(requestHash);
    // Evaluation always precedes lookup. Filesystem evidence is never cached.
    if (decision.decision === "approve" && decision.cache === "session") {
      decision.cached = entry !== undefined && entry.expires > Date.now() && ai === undefined;
      if (!decision.cached) {
        if (this.cache.size >= 512) this.cache.clear();
        this.cache.set(key, {
          expires: Date.now() + 60_000,
          ...(decision.ai ? { ai: { ...decision.ai } } : {}),
        });
      }
    }
    if (decision.needsClassification && !ai) this.noteRequested(request, decision);
    // The compatibility `classify` command may still classify a request a person was asked about.
    if (
      decision.decision === "human" &&
      (["unknown", "cloud-read"].includes(decision.category) || decision.tier === "ambiguous") &&
      !decision.hard &&
      !ai
    ) {
      if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value ?? "");
      this.pending.set(requestHash, request);
    }
    // Every decision replaces the pending creations for this request, so a report can only ever
    // settle the most recent approval: an earlier approval whose report never came is forgotten.
    this.creating.delete(requestHash);
    if (decision.decision === "approve") {
      const targets = creationTargets(request, this.created);
      if (targets.length) {
        if (this.creating.size >= 256)
          this.creating.delete(this.creating.keys().next().value ?? "");
        this.creating.set(requestHash, { targets, approvedAt: Date.now() });
      }
    }
    // The scope label names paths, and rules and notes can, which audit records never contain.
    const {
      ai: classification,
      sessionScopeLabel: _label,
      classifierNote: _note,
      userAllowRule,
      userRule,
      ...safe
    } = decision;
    audit(this.directory, {
      event: "decision",
      ...safe,
      ...(userAllowRule ? { userAllowRule: redactText(userAllowRule, 200) } : {}),
      ...(userRule ? { userRule: redactText(userRule, 200) } : {}),
      ...(classification
        ? {
            ai: {
              category: classification.category,
              confidence: classification.confidence,
              requestHash: classification.requestHash,
            },
          }
        : {}),
    });
    return decision;
  }
  /** Records, once, that an ambiguous request entered classification (for review-classifications). */
  private noteRequested(request: Request, decision: Decision): void {
    if (this.state(decision.requestHash)?.requested) return;
    this.remember(decision.requestHash, { requested: true });
    audit(this.directory, {
      event: "classification-requested",
      requestHash: decision.requestHash,
      tier: "ambiguous",
      reason: decision.reason,
      // A permissive profile keeps a redacted command for risk reviews, as before; the strict
      // default keeps only the vocabulary summary every request record has.
      redactedCommand:
        this.profile.mode === "permissive"
          ? redactText(String(request.input.command ?? request.input.cmd ?? request.tool), 300)
          : String(requestSummary(request).summary),
    });
  }
  /** Runs (or joins) the classifier for a request, audits the run, and returns its result. */
  private runClassifier(request: Request, decision: Decision): Promise<ClassifierResult> {
    const requestHash = decision.requestHash;
    const running = this.running.get(requestHash);
    if (running) return running;
    const cli = request.harness;
    const run = (async (): Promise<ClassifierResult> => {
      let outcome: ClassifierResult;
      if (this.classifierMissing)
        outcome = {
          ok: false,
          reason: "missing",
          cli,
          model: this.profile.classifier[cli].model,
          latencyMs: 0,
        };
      else {
        let prompt: string | undefined;
        try {
          prompt = withCreated(this.created, () =>
            buildPrompt({
              request,
              reason: decision.reason,
              scratchRoots: this.profile.scratchRoots,
            }),
          );
        } catch {
          prompt = undefined;
        }
        try {
          // A command over the length cap (no prompt) is never sent anywhere: the person decides.
          outcome =
            prompt === undefined
              ? {
                  ok: false,
                  reason: "too-long",
                  cli,
                  model: this.profile.classifier[cli].model,
                  latencyMs: 0,
                }
              : await this.deps.classify(cli, prompt, this.profile);
        } catch {
          outcome = {
            ok: false,
            reason: "exit",
            cli,
            model: this.profile.classifier[cli].model,
            latencyMs: 0,
          };
        }
        if (!outcome.ok && outcome.reason === "missing") this.classifierMissing = true;
      }
      // Model, latency and verdict; never the prompt, which holds the command and paths.
      audit(this.directory, {
        event: "ai-classification",
        requestHash,
        cli: outcome.cli,
        model: outcome.model,
        latencyMs: outcome.latencyMs,
        ...(outcome.ok
          ? {
              outcome: "verdict",
              category: outcome.verdict.category,
              confidence: outcome.verdict.confidence,
              recoverable: outcome.verdict.recoverable,
            }
          : { outcome: "failure", failure: outcome.reason }),
      });
      return outcome;
    })();
    this.running.set(requestHash, run);
    return run.finally(() => this.running.delete(requestHash));
  }
  /**
   * The hook's decision. The deterministic engine approves what it can prove safe; otherwise the
   * AI classifier is run synchronously and approves when `recoverable && confidence >= 0.95 &&
   * category not in {sensitive, unknown}`; otherwise a person is asked. The user's own harness
   * rules apply throughout: their deny or ask rule leaves the request to the harness (no
   * decision), and their allow rule counts as the person's answer.
   */
  async decide(
    request: Request,
    phase?: string,
    toolUseId?: string,
    /** The harness's permission mode (Claude Code's `permission_mode`), when it reports one. */
    permissionMode?: string,
  ): Promise<Decision> {
    let decision = this.judge(request, undefined, phase);
    const native =
      decision.decision === "approve" || decision.decision === "human"
        ? this.userRule(request)
        : undefined;
    if (native && native.verdict !== "allow")
      return this.conclude(request, {
        ...decision,
        decision: "native",
        needsClassification: false,
        userRule: native.rule,
        reason: `The user's own ${native.verdict} rule applies`,
      });
    // An allow rule is the person's answer, checked before the classifier so an allowed command
    // never waits on a run. Never for the built-in guards on the policy manager's own approvals,
    // and never for NO_ALLOW: credential reads, writes to what the harness allows, a force push.
    const guarded =
      decision.reason === APPROVE_GUARD ||
      decision.hard === "self-approve" ||
      decision.hard === "foreign-classification-record";
    if (decision.decision === "human" && native?.verdict === "allow" && !guarded) {
      const kept = hardRules(request, decision, this.profile.scratchRoots).find((rule) =>
        NO_ALLOW.has(rule),
      );
      if (kept) {
        audit(this.directory, {
          event: "user-rule-overridden",
          requestHash: decision.requestHash,
          rule: kept,
        });
      } else {
        audit(this.directory, {
          event: "human-response",
          requestHash: decision.requestHash,
          response: "approved",
          summary: "Allowed by the user's own permission rule",
        });
        return this.conclude(request, {
          ...result(request, decision.category, "Allowed by the user's own permission rule", true),
          userAllowRule: native.rule,
        });
      }
    }
    if (decision.decision === "human" && decision.needsClassification && !decision.ai) {
      this.noteRequested(request, decision);
      const outcome = await this.runClassifier(request, decision);
      if (outcome.ok)
        decision = this.judge(
          request,
          { ...outcome.verdict, requestHash: decision.requestHash },
          phase,
          true,
        );
      else {
        this.remember(decision.requestHash, { fallback: true, fallbackReason: outcome.reason });
        audit(this.directory, {
          event: "classification-fallback",
          requestHash: decision.requestHash,
          fallbackReason: outcome.reason,
        });
        decision = {
          ...decision,
          needsClassification: false,
          classification: "fallback",
          fallbackReason: outcome.reason,
        };
      }
    }
    decision = this.conclude(request, decision);
    if (decision.decision === "human" && phase === "PreToolUse")
      this.awaitAnswer(request, decision, toolUseId, permissionMode);
    return decision;
  }
  /**
   * Marks an existing file as created by this session, for `replay`, which rebuilds what a past
   * session created from its transcript. The service never calls it.
   */
  noteCreated(path: string): void {
    const at = located(dirname(path), basename(path));
    const now = at && stamp(at);
    if (at && now) this.created.set(pathKey(at), now);
  }
  private userRule(request: Request): NativeMatch | undefined {
    try {
      return this.deps.nativeRules(request);
    } catch {
      return undefined;
    }
  }
  /**
   * The hook asked, so the harness prompts the person. Its PostToolUse for this exact tool call
   * means they said yes, but only when the harness reports a permission mode in which an ask is
   * really shown to a person: Claude Code's `default`, `acceptEdits` or `plan`. Under
   * `bypassPermissions`, `dontAsk`, an auto mode, or with no mode reported (Copilot reports none,
   * so `--allow-all`/`--yolo` cannot be told apart), nothing is remembered. Codex cannot ask.
   */
  private awaitAnswer(
    request: Request,
    decision: Decision,
    toolUseId: string | undefined,
    permissionMode: string | undefined,
  ): void {
    if (this.harness !== "claude") return;
    if (!permissionMode || !PROMPTING_MODES.has(permissionMode)) return;
    if (!toolUseId || !/^[\w.:-]{1,200}$/.test(toolUseId)) return;
    if (this.asks.size >= 256) this.asks.delete(this.asks.keys().next().value ?? "");
    this.asks.set(toolUseId, { request, decision, at: Date.now() });
  }
  /**
   * PostToolUse (or PostToolUseFailure) for a tool call the harness asked the person about: they
   * said yes. The answer is remembered like `approve --session`: the same rule for the same scope
   * is approved for the rest of the session (a protected root, a humanPatterns entry, or the exact
   * command for other rules); unknown, sensitive and destructive requests stay once-only.
   */
  answered(report: AskReport): "session" | "once" | "rejected" | undefined {
    const key =
      this.harness === "claude"
        ? report.toolUseId
        : this.harness === "copilot"
          ? `request:${report.requestHash}`
          : undefined;
    if (!key) return undefined;
    const ask = this.asks.get(key);
    if (!ask || ask.decision.requestHash !== report.requestHash) return undefined;
    this.asks.delete(key);
    if (Date.now() - ask.at > ASK_WINDOW_MS) return undefined;
    if (
      report.phase === "PostToolUseFailure" &&
      (report.interrupted || REJECTED.test(report.error ?? ""))
    ) {
      audit(this.directory, {
        event: "human-response",
        requestHash: report.requestHash,
        response: "denied",
        summary: "The harness prompt did not run the tool",
      });
      return "rejected";
    }
    this.humanDecisions.delete(report.requestHash);
    const scope = grantScope(ask.request, ask.decision, this.profile);
    audit(this.directory, {
      event: "human-response",
      requestHash: report.requestHash,
      response: "approved",
      summary: "User approved the harness prompt",
    });
    if (scope === undefined) return "once";
    const scopeHash = this.addSessionGrant(ask.decision.reason, scope);
    audit(this.directory, {
      event: "human-grant",
      requestHash: report.requestHash,
      category: ask.decision.category,
      scope: "session",
      scopeHash,
      summary: "User approved the harness prompt; the rule is remembered for this session",
    });
    return "session";
  }
  record(report: OutcomeReport): void {
    if (!report || !/^[a-f0-9]{64}$/.test(report.requestHash))
      throw new Error("A request hash is required");
    if (report.event === "human-response") {
      if (!["approved", "denied"].includes(report.response ?? ""))
        throw new Error("Invalid human response");
      audit(this.directory, {
        event: report.event,
        requestHash: report.requestHash,
        response: report.response,
        summary: "Harness-reported human response",
      });
    } else if (report.event === "execution-result") {
      if (
        !["completed", "succeeded", "failed", "cancelled", "unknown"].includes(report.status ?? "")
      )
        throw new Error("Invalid execution status");
      if (
        report.exitCode !== undefined &&
        (!Number.isSafeInteger(report.exitCode) || Math.abs(report.exitCode) > 2147483647)
      )
        throw new Error("Invalid exit code");
      if (
        report.durationMs !== undefined &&
        (!Number.isFinite(report.durationMs) || report.durationMs < 0)
      )
        throw new Error("Invalid execution duration");
      audit(this.directory, {
        event: report.event,
        requestHash: report.requestHash,
        status: report.status,
        ...(report.exitCode === undefined ? {} : { exitCode: report.exitCode }),
        ...(report.durationMs === undefined ? {} : { durationMs: report.durationMs }),
        summary: "Harness-reported execution result",
      });
      // A target is the session's only if `settle` proves the file there is its own inode or a new
      // one born after the approval; otherwise any earlier claim on the path is dropped.
      // A report that comes too long after its approval records nothing.
      const pending = this.creating.get(report.requestHash);
      const fresh =
        pending && Date.now() - pending.approvedAt <= CREATION_REPORT_MS ? pending : undefined;
      for (const target of fresh?.targets ?? []) {
        const now = settle(target, fresh?.approvedAt ?? Number.POSITIVE_INFINITY);
        if (!now) this.created.delete(pathKey(target.path));
        else {
          if (this.created.size >= 4096) this.created.clear();
          this.created.set(pathKey(target.path), now);
        }
      }
      this.creating.delete(report.requestHash);
    } else throw new Error("Invalid outcome event");
  }
  /** The compatibility `classify` command: a recorded classification for a pending request. */
  classify(classification: Classification): Decision {
    const request = this.pending.get(classification.requestHash);
    if (!request) throw new Error("No pending request matches the classification");
    // One classification per request: a verdict, deny or approve, cannot be replaced. A request
    // the hook's classifier could not settle (too long, disabled, missing, failed) is a person's.
    const known = this.state(classification.requestHash);
    if (known?.ai) throw new Error("The request is already classified");
    if (known?.fallback || known?.invalid)
      throw new Error("The request is waiting for a person, not a classification");
    this.pending.delete(classification.requestHash);
    try {
      return this.review(request, classification);
    } catch (error) {
      this.remember(classification.requestHash, { invalid: true });
      throw error;
    }
  }
}
