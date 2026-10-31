import { type EventType, hintFor, type PrEvent } from "./events.js";
import { formatRef, type PrRef } from "./ref.js";
import type { Snapshot } from "./snapshot.js";

export interface DiffOptions {
  ref: PrRef;
  /** Emit `stale` once the branch is at least this many commits behind base. */
  staleAfter: number;
  /** Lower-cased logins whose comments and reviews never produce events. */
  ignoreAuthors: ReadonlySet<string>;
  ignoreBots: boolean;
  /** On the baseline, also replay every existing review and comment as `initial` events. */
  includeExisting?: boolean;
  now?: () => Date;
}

/**
 * Compare two snapshots and describe what changed. With `prev === null` only
 * conditions that already hold (stale, conflicts, failing checks, terminal
 * state) are reported, flagged `initial`; historical comments are not replayed.
 */
export function diffSnapshots(prev: Snapshot | null, next: Snapshot, opts: DiffOptions): PrEvent[] {
  const events: PrEvent[] = [];
  const pr = formatRef(opts.ref);
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const emit = (type: EventType, data: Record<string, unknown> = {}, initial = false) => {
    events.push({
      type,
      pr,
      at,
      ...(initial ? { initial: true as const } : {}),
      data,
      hint: hintFor(type),
    });
  };
  const ignored = (user: string) =>
    opts.ignoreAuthors.has(user.toLowerCase()) || (opts.ignoreBots && user.endsWith("[bot]"));

  const emitReviews = (reviews: Snapshot["reviews"], initial: boolean) => {
    for (const r of reviews) {
      if (ignored(r.user)) continue;
      const { id, user, body, url } = r;
      if (r.state === "APPROVED") emit("review_approved", { id, user, body, url }, initial);
      else if (r.state === "CHANGES_REQUESTED") {
        emit("review_changes_requested", { id, user, body, url }, initial);
      } else if (r.state === "COMMENTED" && body.trim()) {
        emit("review_commented", { id, user, body, url }, initial);
      }
    }
  };

  const stale = (s: Snapshot) => s.state === "open" && s.behindBy >= opts.staleAfter;
  const failing = (s: Snapshot) => s.checks.state === "failure";

  if (!prev) {
    if (stale(next)) emit("stale", { behindBy: next.behindBy, threshold: opts.staleAfter }, true);
    if (next.conflicting === true && next.state === "open") {
      emit("conflicts", { mergeableState: next.mergeableState }, true);
    }
    if (failing(next) && next.state === "open") {
      emit("checks_failed", { failing: next.checks.failing, headSha: next.headSha }, true);
    }
    if (opts.includeExisting) {
      emitReviews(next.reviews, true);
      for (const c of next.reviewComments)
        if (!ignored(c.user)) emit("review_comment", { ...c }, true);
      for (const c of next.comments) if (!ignored(c.user)) emit("comment", { ...c }, true);
    } else {
      // Feedback that is still blocking the PR counts as a standing condition, like staleness.
      const latest = new Map<string, Snapshot["reviews"][number]>();
      for (const r of next.reviews) {
        if (r.state === "COMMENTED") continue;
        if (r.state === "CHANGES_REQUESTED" || r.state === "APPROVED") latest.set(r.user, r);
        else latest.delete(r.user); // DISMISSED
      }
      if (next.state === "open") {
        emitReviews(
          [...latest.values()].filter((r) => r.state === "CHANGES_REQUESTED"),
          true,
        );
      }
    }
    pushTerminal(emit, next, true);
    return events;
  }

  if (prev.headSha !== next.headSha) emit("head_updated", { from: prev.headSha, to: next.headSha });
  if (prev.baseSha !== next.baseSha && next.state === "open") {
    emit("base_moved", { baseRef: next.baseRef, from: prev.baseSha, to: next.baseSha });
  }
  if (!stale(prev) && stale(next)) {
    emit("stale", { behindBy: next.behindBy, threshold: opts.staleAfter });
  }
  if (prev.draft && !next.draft && next.state === "open") emit("ready_for_review");

  if (next.conflicting === true && prev.conflicting !== true) {
    emit("conflicts", { mergeableState: next.mergeableState });
  } else if (next.conflicting === false && prev.conflicting === true) {
    emit("conflicts_resolved", { mergeableState: next.mergeableState });
  }

  const headChanged = prev.headSha !== next.headSha;
  const newlyFailing = next.checks.failing.filter(
    (name) => headChanged || !prev.checks.failing.includes(name),
  );
  if (newlyFailing.length > 0) {
    emit("checks_failed", { failing: next.checks.failing, headSha: next.headSha });
  }
  if (next.checks.state === "success" && (prev.checks.state !== "success" || headChanged)) {
    emit("checks_passed", { headSha: next.headSha });
  }

  const seenReviews = new Set(prev.reviews.map((r) => r.id));
  emitReviews(
    next.reviews.filter((r) => !seenReviews.has(r.id)),
    false,
  );

  const seenInline = new Set(prev.reviewComments.map((c) => c.id));
  for (const c of next.reviewComments) {
    if (seenInline.has(c.id) || ignored(c.user)) continue;
    emit("review_comment", { ...c });
  }

  const seenComments = new Set(prev.comments.map((c) => c.id));
  for (const c of next.comments) {
    if (seenComments.has(c.id) || ignored(c.user)) continue;
    emit("comment", { ...c });
  }

  if (prev.state === "open") pushTerminal(emit, next, false);
  else if (next.state === "open") emit("pr_reopened");
  return events;
}

function pushTerminal(
  emit: (type: EventType, data?: Record<string, unknown>, initial?: boolean) => void,
  next: Snapshot,
  initial: boolean,
): void {
  if (next.state === "merged") emit("pr_merged", { mergedBy: next.mergedBy }, initial);
  else if (next.state === "closed") emit("pr_closed", {}, initial);
}
