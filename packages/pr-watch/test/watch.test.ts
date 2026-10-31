import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrEvent } from "../src/events.js";
import { GithubError } from "../src/github.js";
import type { Snapshot } from "../src/snapshot.js";
import { watch } from "../src/watch.js";
import { diffOpts, REF, snap } from "./helpers.js";

function harness(
  script: Array<Snapshot | Error>,
  extra: Partial<Parameters<typeof watch>[0]> = {},
) {
  let i = 0;
  let clock = 0;
  const sleeps: number[] = [];
  const events: PrEvent[] = [];
  const opts = {
    ...diffOpts(),
    ref: REF,
    fetchSnapshot: async () => {
      const item = script[Math.min(i++, script.length - 1)] as Snapshot | Error;
      if (item instanceof Error) throw item;
      return item;
    },
    intervalMs: 1000,
    timeoutMs: 0,
    follow: false,
    only: null,
    onEvent: (e: PrEvent) => events.push(e),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    nowMs: () => clock,
    ...extra,
  };
  return { opts, events, sleeps, polls: () => i };
}

describe("watch", () => {
  it("polls until an event appears, then exits", async () => {
    const h = harness([snap(), snap(), snap({ baseSha: "b2", behindBy: 1 })]);
    const r = await watch(h.opts);
    expect(r.outcome).toBe("events");
    expect(h.events.map((e) => e.type)).toEqual(["base_moved", "stale"]);
    expect(h.polls()).toBe(3);
  });

  it("exits immediately when the baseline is already problematic", async () => {
    const h = harness([snap({ behindBy: 2 })]);
    expect((await watch(h.opts)).outcome).toBe("events");
    expect(h.events[0]?.initial).toBe(true);
  });

  it("times out when nothing happens", async () => {
    const h = harness([snap()], { timeoutMs: 3500 });
    const r = await watch(h.opts);
    expect(r.outcome).toBe("timeout");
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(3500);
  });

  it("filters events but always lets terminal events through", async () => {
    const h = harness(
      [
        snap(),
        snap({ comments: [{ id: 1, user: "x", body: "b", url: "u" }] }),
        snap({ state: "merged" }),
      ],
      { only: new Set(["review_approved"]) },
    );
    const r = await watch(h.opts);
    expect(r.outcome).toBe("terminal");
    expect(h.events.map((e) => e.type)).toEqual(["pr_merged"]);
  });

  it("does not wake on informational events such as head_updated", async () => {
    const h = harness([
      snap(),
      snap({ headSha: "h2", checks: { state: "pending", failing: [] } }),
      snap({
        headSha: "h2",
        checks: { state: "pending", failing: [] },
        comments: [{ id: 1, user: "x", body: "b", url: "u" }],
      }),
    ]);
    const r = await watch(h.opts);
    expect(r.outcome).toBe("events");
    expect(h.events.map((e) => e.type)).toEqual(["head_updated", "comment"]);
    expect(h.polls()).toBe(3);
  });

  it("reports an already-merged PR instead of waiting forever when resuming from state", async () => {
    const h = harness([snap({ state: "merged" })], {
      stateFile: join(await mkdtemp(join(tmpdir(), "pr-watch-")), "s.json"),
    });
    await watch({ ...h.opts, fetchSnapshot: async () => snap({ state: "merged" }) });
    const second = harness([snap({ state: "merged" })], { stateFile: h.opts.stateFile });
    const r = await watch(second.opts);
    expect(r.outcome).toBe("terminal");
    expect(second.events.map((e) => e.type)).toEqual(["pr_merged"]);
  });

  it("keeps going with --follow until terminal", async () => {
    const c = { id: 1, user: "x", body: "b", url: "u" };
    const h = harness([snap(), snap({ comments: [c] }), snap({ comments: [c], state: "closed" })], {
      follow: true,
    });
    const r = await watch(h.opts);
    expect(r.outcome).toBe("terminal");
    expect(h.events.map((e) => e.type)).toEqual(["comment", "pr_closed"]);
  });

  it("retries transient errors with backoff, then recovers", async () => {
    const h = harness([new Error("ECONNRESET"), new Error("ECONNRESET"), snap({ behindBy: 1 })]);
    const r = await watch(h.opts);
    expect(r.outcome).toBe("events");
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("gives up after repeated failures", async () => {
    const h = harness([new Error("down")], { maxConsecutiveFailures: 3 });
    await expect(watch(h.opts)).rejects.toThrow("down");
    expect(h.polls()).toBe(3);
  });

  it("fails fast on fatal API errors", async () => {
    const h = harness([new GithubError("not found", 404)]);
    await expect(watch(h.opts)).rejects.toThrow("not found");
    expect(h.polls()).toBe(1);
  });

  it("waits out rate limits without counting a full backoff", async () => {
    const h = harness([new GithubError("limited", 403, 30_000), snap({ behindBy: 1 })]);
    const r = await watch(h.opts);
    expect(r.outcome).toBe("events");
    expect(h.sleeps).toEqual([30_000]);
  });

  it("returns aborted when the signal fires", async () => {
    const controller = new AbortController();
    const h = harness([snap()], {
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    expect((await watch(h.opts)).outcome).toBe("aborted");
  });

  it("persists state so a later run reports what happened in between", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-watch-"));
    const stateFile = join(dir, "nested", "state.json");

    const first = harness([snap()], { stateFile, timeoutMs: 500 });
    expect((await watch(first.opts)).outcome).toBe("timeout");
    expect(JSON.parse(await readFile(stateFile, "utf8")).pr).toBe("acme/app#7");

    const second = harness([snap({ headSha: "head2" })], { stateFile });
    const r = await watch(second.opts);
    expect(r.outcome).toBe("events");
    expect(second.events.map((e) => e.type)).toEqual(["head_updated", "checks_passed"]);
  });
});
