import { audit, requestSummary } from "./audit.js";
import { evaluate, hash } from "./policy.js";
import type { Classification, Decision, OutcomeReport, Request } from "./types.js";

export class PolicySession {
  private cache = new Map<string, { expires: number; ai?: Classification }>();
  private pending = new Map<string, Request>();
  constructor(
    readonly directory: string,
    readonly harness: string,
    readonly sessionId: string,
  ) {}
  review(request: Request, ai?: Classification): Decision {
    if (request.sessionId !== this.sessionId || request.harness !== this.harness)
      throw new Error("Session mismatch");
    audit(this.directory, { event: "request", ...requestSummary(request) });
    if (
      ai &&
      (![
        "code-read",
        "worktree-write",
        "cloud-read",
        "git-read",
        "impactful-write",
        "destructive",
        "sensitive",
        "unknown",
      ].includes(ai.category) ||
        typeof ai.confidence !== "number" ||
        !Number.isFinite(ai.confidence) ||
        !/^[a-f0-9]{64}$/.test(ai.requestHash))
    ) {
      audit(this.directory, {
        event: "decision",
        decision: "human",
        category: "unknown",
        reason: "Malformed AI classification",
        requestHash: hash(request),
      });
      throw new Error("Malformed AI classification");
    }
    const key = hash([hash(request), "policy-v1"]);
    const entry = this.cache.get(key);
    const cachedAi = entry && entry.expires > Date.now() ? entry.ai : undefined;
    if (ai)
      audit(this.directory, {
        event: "classification",
        requestHash: hash(request),
        category: ai.category,
        confidence: ai.confidence,
      });
    const decision = evaluate(request, ai ?? cachedAi);
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
    if (
      decision.decision === "human" &&
      ["unknown", "cloud-read"].includes(decision.category) &&
      !ai
    ) {
      if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value ?? "");
      this.pending.set(decision.requestHash, request);
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
      if (!["completed", "succeeded", "failed", "cancelled"].includes(report.status ?? ""))
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
    } else throw new Error("Invalid outcome event");
  }
  classify(classification: Classification): Decision {
    const request = this.pending.get(classification.requestHash);
    if (!request) throw new Error("No pending request matches the classification");
    this.pending.delete(classification.requestHash);
    return this.review(request, classification);
  }
}
