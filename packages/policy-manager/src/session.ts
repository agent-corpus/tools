import { audit, requestSummary } from "./audit.js";
import {
  type CreatedFiles,
  creationTargets,
  pathKey,
  settle,
  type Target,
  withCreated,
} from "./created.js";
import { evaluate, hash, requestHash as requestHashOf } from "./policy.js";
import { type Profile, strictProfile } from "./profile.js";
import { redactText } from "./redact.js";
import {
  CATEGORIES,
  type Classification,
  type Decision,
  type OutcomeReport,
  type Request,
} from "./types.js";

/** How long a classification outcome for one exact request is remembered. */
const CLASSIFICATION_TTL_MS = 5 * 60_000;
/** AI approvals per session; beyond this, ambiguous requests go to a human. */
export const MAX_AI_APPROVALS = 50;

interface ClassificationState {
  expires: number;
  /** The hook has already blocked this request once with the instruction to classify it. */
  requested: boolean;
  invalid: boolean;
  fallback: boolean;
  /** The session cap on AI approvals was reached when this request was classified. */
  limited: boolean;
  ai?: Classification;
}

export class PolicySession {
  private cache = new Map<string, { expires: number; ai?: Classification }>();
  private pending = new Map<string, Request>();
  private states = new Map<string, ClassificationState>();
  /** Requests the AI approved, counted once each however often they are retried. */
  private approvedByAi = new Set<string>();
  /** Files this session created, and the paths each approved request may create. */
  private created: CreatedFiles = new Map();
  private creating = new Map<string, { targets: Target[]; approvedAt: number }>();
  constructor(
    readonly directory: string,
    readonly harness: string,
    readonly sessionId: string,
    readonly profile: Profile = strictProfile,
  ) {}
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
      requested: false,
      invalid: false,
      fallback: false,
      limited: false,
      ...this.states.get(requestHash),
      ...change,
      expires: Date.now() + CLASSIFICATION_TTL_MS,
    });
  }
  /**
   * `phase` is the hook event. Only `PreToolUse` runs the classification flow: the first time an
   * ambiguous request arrives it is blocked with an instruction to classify and retry; the next
   * time, with no usable classification, a human is asked and the reason is recorded.
   */
  review(request: Request, ai?: Classification, phase?: string): Decision {
    if (request.sessionId !== this.sessionId || request.harness !== this.harness)
      throw new Error("Session mismatch");
    audit(this.directory, { event: "request", ...requestSummary(request) });
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
    const key = hash([
      requestHashOf(request),
      "policy-v1",
      this.profile.digest ?? this.profile.mode,
    ]);
    const entry = this.cache.get(key);
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
    let decision = withCreated(this.created, () =>
      evaluate(request, ai ?? cachedAi ?? known?.ai, this.profile),
    );
    if (decision.tier === "ambiguous") {
      if (ai && !decision.classification) this.remember(requestHash, { invalid: true });
      else if (ai) {
        // The cap is checked when the approval is first given and stored with the outcome, so a
        // retry cannot turn a limited request into an approval.
        if (
          decision.classification === "approved" &&
          !this.approvedByAi.has(requestHash) &&
          this.approvedByAi.size >= MAX_AI_APPROVALS
        ) {
          decision = {
            ...decision,
            decision: "human",
            classification: "fallback",
            fallbackReason: "limit",
            reason: "Session limit on AI approvals reached; a human decides",
          };
          this.remember(requestHash, { limited: true });
        } else {
          if (decision.classification === "approved") this.approvedByAi.add(requestHash);
          this.remember(requestHash, { ai });
        }
      }
      if (decision.needsClassification && !ai && phase === "PreToolUse") {
        if (!known?.requested) {
          this.remember(requestHash, { requested: true });
          audit(this.directory, {
            event: "classification-requested",
            requestHash,
            tier: "ambiguous",
            reason: decision.reason,
            redactedCommand: redactText(
              String(request.input.command ?? request.input.cmd ?? request.tool),
              300,
            ),
          });
          decision = { ...decision, decision: "deny", classification: "requested" };
        } else {
          const fallbackReason = known.limited
            ? "limit"
            : known.invalid
              ? "invalid-result"
              : "unavailable";
          if (!known.fallback) {
            this.remember(requestHash, { fallback: true });
            audit(this.directory, {
              event: "classification-fallback",
              requestHash,
              fallbackReason,
            });
          }
          decision = { ...decision, classification: "fallback", fallbackReason };
        }
      }
    }
    if (decision.decision === "human") this.cache.delete(key);
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
    // A denied request is final for its remembered state: only a human decision or a request
    // still waiting for its first classification can be classified.
    if (
      (decision.decision === "human" || decision.classification === "requested") &&
      (["unknown", "cloud-read"].includes(decision.category) || decision.needsClassification) &&
      !ai
    ) {
      if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value ?? "");
      this.pending.set(decision.requestHash, request);
    }
    if (decision.decision === "approve") {
      const targets = creationTargets(request, this.created);
      if (targets.length) {
        if (this.creating.size >= 256)
          this.creating.delete(this.creating.keys().next().value ?? "");
        this.creating.set(decision.requestHash, { targets, approvedAt: Date.now() });
      }
    }
    const { ai: classification, ...safe } = decision;
    audit(this.directory, {
      event: "decision",
      ...safe,
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
      const pending = this.creating.get(report.requestHash);
      for (const target of pending?.targets ?? []) {
        const now = settle(target, pending?.approvedAt ?? Number.POSITIVE_INFINITY);
        if (!now) this.created.delete(pathKey(target.path));
        else {
          if (this.created.size >= 4096) this.created.clear();
          this.created.set(pathKey(target.path), now);
        }
      }
      this.creating.delete(report.requestHash);
    } else throw new Error("Invalid outcome event");
  }
  classify(classification: Classification): Decision {
    const request = this.pending.get(classification.requestHash);
    if (!request) throw new Error("No pending request matches the classification");
    // One classification per request: a verdict, deny or approve, cannot be replaced.
    if (this.state(classification.requestHash)?.ai)
      throw new Error("The request is already classified");
    this.pending.delete(classification.requestHash);
    try {
      return this.review(request, classification);
    } catch (error) {
      // A malformed result is not an approval; the retry will fall back to a human, with the
      // reason recorded for the review.
      this.remember(classification.requestHash, { invalid: true });
      throw error;
    }
  }
}
