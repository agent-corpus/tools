import { audit, requestSummary } from "./audit.js";
import { evaluate, hash } from "./policy.js";
import type { Classification, Decision, Request } from "./types.js";

export class PolicySession {
  private cache = new Map<string, number>();
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
    const decision = evaluate(request, ai);
    const key = hash([decision.requestHash, "policy-v1"]);
    // Evaluation always precedes lookup. Filesystem evidence is never cached.
    if (decision.decision === "approve" && decision.cache === "session") {
      const expires = this.cache.get(key);
      decision.cached = expires !== undefined && expires > Date.now();
      if (!decision.cached) {
        if (this.cache.size >= 512) this.cache.clear();
        this.cache.set(key, Date.now() + 60_000);
      }
    }
    if (decision.category === "unknown" && !ai) {
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
  classify(classification: Classification): Decision {
    const request = this.pending.get(classification.requestHash);
    if (!request) throw new Error("No pending request matches the classification");
    this.pending.delete(classification.requestHash);
    return this.review(request, classification);
  }
}
