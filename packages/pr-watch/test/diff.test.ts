import { describe, expect, it } from "vitest";
import { diffSnapshots } from "../src/diff.js";
import { diffOpts, snap } from "./helpers.js";

const types = (
  prev: Parameters<typeof diffSnapshots>[0],
  next: Parameters<typeof diffSnapshots>[1],
  o = diffOpts(),
) => diffSnapshots(prev, next, o).map((e) => e.type);

describe("diffSnapshots: baseline", () => {
  it("reports nothing for a healthy PR", () => {
    expect(types(null, snap())).toEqual([]);
  });
  it("reports existing problems as initial", () => {
    const events = diffSnapshots(
      null,
      snap({ behindBy: 3, conflicting: true, checks: { state: "failure", failing: ["build"] } }),
      diffOpts(),
    );
    expect(events.map((e) => e.type)).toEqual(["stale", "conflicts", "checks_failed"]);
    expect(events.every((e) => e.initial)).toBe(true);
  });
  it("does not replay historical comments", () => {
    const comments = [{ id: 1, user: "bob", body: "hi", url: "u" }];
    expect(types(null, snap({ comments }))).toEqual([]);
  });
  it("reports an already merged PR", () => {
    expect(types(null, snap({ state: "merged" }))).toEqual(["pr_merged"]);
  });
});

describe("diffSnapshots: transitions", () => {
  it("emits base_moved and stale when main advances", () => {
    expect(types(snap(), snap({ baseSha: "base2", behindBy: 2 }))).toEqual(["base_moved", "stale"]);
  });
  it("does not repeat stale while still stale", () => {
    expect(types(snap({ behindBy: 2 }), snap({ behindBy: 3, baseSha: "b3" }))).toEqual([
      "base_moved",
    ]);
  });
  it("honours --stale-after", () => {
    const o = diffOpts({ staleAfter: 5 });
    expect(types(snap(), snap({ baseSha: "b2", behindBy: 4 }), o)).toEqual(["base_moved"]);
    expect(types(snap({ behindBy: 4 }), snap({ baseSha: "b2", behindBy: 5 }), o)).toEqual([
      "base_moved",
      "stale",
    ]);
  });
  it("emits stale again after a rebase and a new advance", () => {
    expect(types(snap({ behindBy: 0 }), snap({ behindBy: 1 }))).toEqual(["stale"]);
  });
  it("detects head updates", () => {
    const pending = { state: "pending" as const, failing: [] };
    expect(types(snap(), snap({ headSha: "head2", checks: pending }))).toEqual(["head_updated"]);
    // checks already green on the new commit count as a fresh pass
    expect(types(snap(), snap({ headSha: "head2" }))).toEqual(["head_updated", "checks_passed"]);
  });
  it("detects conflict and resolution", () => {
    expect(types(snap(), snap({ conflicting: true, mergeableState: "dirty" }))).toEqual([
      "conflicts",
    ]);
    expect(types(snap({ conflicting: true }), snap({ conflicting: false }))).toEqual([
      "conflicts_resolved",
    ]);
  });
  it("detects draft -> ready", () => {
    expect(types(snap({ draft: true }), snap())).toEqual(["ready_for_review"]);
  });
  it("reports merge and close, without a noisy base_moved", () => {
    expect(types(snap(), snap({ state: "merged", baseSha: "b2", mergedBy: "x" }))).toEqual([
      "pr_merged",
    ]);
    expect(types(snap(), snap({ state: "closed" }))).toEqual(["pr_closed"]);
  });
  it("does not re-emit terminal events once already terminal", () => {
    expect(types(snap({ state: "merged" }), snap({ state: "merged" }))).toEqual([]);
  });
});

describe("diffSnapshots: checks", () => {
  it("emits checks_failed for newly failing checks only", () => {
    const failing = (...f: string[]) => snap({ checks: { state: "failure", failing: f } });
    expect(types(snap(), failing("a"))).toEqual(["checks_failed"]);
    expect(types(failing("a"), failing("a"))).toEqual([]);
    expect(types(failing("a"), failing("a", "b"))).toEqual(["checks_failed"]);
  });
  it("re-reports failure on a new commit", () => {
    const failing = (sha: string) =>
      snap({ headSha: sha, checks: { state: "failure", failing: ["a"] } });
    expect(types(failing("h1"), failing("h2"))).toEqual(["head_updated", "checks_failed"]);
  });
  it("emits checks_passed on transition to success", () => {
    expect(types(snap({ checks: { state: "pending", failing: [] } }), snap())).toEqual([
      "checks_passed",
    ]);
    expect(types(snap(), snap())).toEqual([]);
  });
});

describe("diffSnapshots: reviews and comments", () => {
  const review = (id: number, state: string, body = "text", user = "alice") => ({
    id,
    user,
    state,
    body,
    url: `u${id}`,
    submittedAt: null,
  });

  it("maps review states to event types", () => {
    const next = snap({
      reviews: [review(1, "APPROVED"), review(2, "CHANGES_REQUESTED"), review(3, "COMMENTED")],
    });
    expect(types(snap(), next)).toEqual([
      "review_approved",
      "review_changes_requested",
      "review_commented",
    ]);
  });
  it("skips empty COMMENTED reviews (inline comments carry the content)", () => {
    expect(types(snap(), snap({ reviews: [review(1, "COMMENTED", "  ")] }))).toEqual([]);
  });
  it("does not re-emit known reviews or ones that were dismissed later", () => {
    const prev = snap({ reviews: [review(1, "CHANGES_REQUESTED")] });
    expect(types(prev, snap({ reviews: [review(1, "DISMISSED")] }))).toEqual([]);
  });
  it("emits inline and conversation comments once", () => {
    const inline = {
      id: 5,
      user: "bob",
      path: "a.ts",
      line: 3,
      body: "nit",
      url: "u",
      inReplyTo: null,
    };
    const conv = { id: 6, user: "bob", body: "ping", url: "u" };
    const prev = snap();
    const next = snap({ reviewComments: [inline], comments: [conv] });
    expect(types(prev, next)).toEqual(["review_comment", "comment"]);
    expect(types(next, next)).toEqual([]);
  });
  it("filters ignored authors and bots", () => {
    const next = snap({
      comments: [
        { id: 1, user: "Me", body: "x", url: "u" },
        { id: 2, user: "ci[bot]", body: "x", url: "u" },
        { id: 3, user: "carol", body: "x", url: "u" },
      ],
    });
    const o = diffOpts({ ignoreAuthors: new Set(["me"]), ignoreBots: true });
    const events = diffSnapshots(snap(), next, o);
    expect(events.map((e) => e.data.user)).toEqual(["carol"]);
  });
  it("attaches a hint to every event", () => {
    const events = diffSnapshots(snap(), snap({ baseSha: "b2", behindBy: 1 }), diffOpts());
    expect(events.every((e) => e.hint.length > 0)).toBe(true);
  });
});
