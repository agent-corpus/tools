import { describe, expect, it } from "vitest";
import { aggregateChecks, carryForward } from "../src/snapshot.js";
import { snap } from "./helpers.js";

const run = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
});

describe("aggregateChecks", () => {
  it("is none without checks", () => {
    expect(aggregateChecks([], [])).toEqual({ state: "none", failing: [] });
  });
  it("is success when all complete green or skipped", () => {
    const r = aggregateChecks(
      [run("a", "completed", "success"), run("b", "completed", "skipped")],
      [],
    );
    expect(r.state).toBe("success");
  });
  it("is pending while any run is in progress", () => {
    expect(
      aggregateChecks([run("a", "completed", "success"), run("b", "in_progress", null)], []).state,
    ).toBe("pending");
  });
  it("is failure as soon as one fails, even if others are pending", () => {
    const r = aggregateChecks([run("a", "completed", "failure"), run("b", "queued", null)], []);
    expect(r).toEqual({ state: "failure", failing: ["a"] });
  });
  it("includes legacy commit statuses", () => {
    const r = aggregateChecks([], [{ context: "ci/legacy", state: "error" }]);
    expect(r).toEqual({ state: "failure", failing: ["ci/legacy"] });
  });
});

describe("carryForward", () => {
  it("keeps the previous mergeability while GitHub recomputes", () => {
    const merged = carryForward(snap({ conflicting: true }), snap({ conflicting: null }));
    expect(merged.conflicting).toBe(true);
  });
  it("passes through known values", () => {
    expect(
      carryForward(snap({ conflicting: true }), snap({ conflicting: false })).conflicting,
    ).toBe(false);
  });
});
