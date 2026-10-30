import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Io, run } from "../src/main.js";

/** A tiny fake GitHub API whose PR state tests can mutate between polls. */
class FakeGithub {
  server!: Server;
  url = "";
  baseSha = "base1";
  headSha = "head1";
  behindBy = 0;
  prState: "open" | "merged" = "open";
  baseDeleted = false;
  reviews: unknown[] = [];
  comments: unknown[] = [];
  requests: string[] = [];

  async start() {
    this.server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0] as string;
      this.requests.push(path);
      const send = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/repos/acme/app/pulls/7") {
        return send({
          title: "Add thing",
          html_url: "https://github.com/acme/app/pull/7",
          user: { login: "dev" },
          state: this.prState === "merged" ? "closed" : "open",
          merged: this.prState === "merged",
          merged_by: this.prState === "merged" ? { login: "boss" } : null,
          draft: false,
          mergeable: true,
          mergeable_state: "clean",
          base: { ref: "main", sha: "base-at-merge" },
          head: { ref: "feature", sha: this.headSha },
        });
      }
      if (path === "/repos/acme/app/branches/main") {
        if (this.baseDeleted) return send({ message: "Branch not found" }, 404);
        return send({ commit: { sha: this.baseSha } });
      }
      if (path.startsWith("/repos/acme/app/compare/"))
        return send({ ahead_by: 1, behind_by: this.behindBy });
      if (path === "/repos/acme/app/pulls/7/reviews") return send(this.reviews);
      if (path === "/repos/acme/app/pulls/7/comments") return send([]);
      if (path === "/repos/acme/app/issues/7/comments") return send(this.comments);
      if (path.endsWith("/check-runs"))
        return send({
          check_runs: [{ name: "build", status: "completed", conclusion: "success" }],
        });
      if (path.endsWith("/status")) return send({ total_count: 0, statuses: [] });
      if (path === "/user") return send({ login: "me" });
      send({ message: "Not Found" }, 404);
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise((r) => this.server.close(r));
  }
}

let gh: FakeGithub;
beforeEach(async () => {
  gh = new FakeGithub();
  await gh.start();
});
afterEach(() => gh.stop());

function harness(onSleep: (n: number) => void = () => {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { GITHUB_TOKEN: "t", GITHUB_API_URL: gh.url },
    sleep: async () => onSleep(out.length),
  };
  const events = () =>
    out
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { io, out, err, events };
}

const PR = "https://github.com/acme/app/pull/7";

describe("cli", () => {
  it("prints help and usage without network access", async () => {
    const h = harness();
    expect(await run([], h.io)).toBe(0);
    expect(h.out.join("")).toContain("pr-watch usage");
    const u = harness();
    expect(await run(["usage"], u.io)).toBe(0);
    expect(u.out.join("")).toContain("## Events");
    const j = harness();
    await run(["usage", "--json"], j.io);
    expect(JSON.parse(j.out.join("")).events.length).toBeGreaterThan(5);
  });

  it("rejects bad input with exit 2", async () => {
    for (const argv of [
      ["bogus"],
      ["watch"],
      ["watch", "nope"],
      ["watch", PR, "--interval", "0s"],
      ["watch", PR, "--events", "nonsense"],
      ["watch", PR, "--wat"],
      ["watch", PR, "--stale-after", "0"],
    ]) {
      const h = harness();
      expect(await run(argv, h.io), argv.join(" ")).toBe(2);
      expect(h.err.join("")).toContain("pr-watch:");
    }
  });

  it("status prints a summary", async () => {
    gh.reviews = [{ id: 1, user: { login: "alice" }, state: "APPROVED", body: "", html_url: "u" }];
    const h = harness();
    expect(await run(["status", PR], h.io)).toBe(0);
    const s = JSON.parse(h.out.join(""));
    expect(s).toMatchObject({
      pr: "acme/app#7",
      state: "open",
      behindBy: 0,
      reviews: [{ user: "alice", state: "APPROVED" }],
    });
  });

  it("watch emits stale when main moves ahead, then exits 0", async () => {
    const h = harness((lines) => {
      if (lines === 0) {
        gh.baseSha = "base2";
        gh.behindBy = 3;
      }
    });
    expect(await run(["watch", PR, "--interval", "1s"], h.io)).toBe(0);
    const events = h.events();
    expect(events.map((e) => e.type)).toEqual(["base_moved", "stale"]);
    expect(events[1]).toMatchObject({ pr: "acme/app#7", data: { behindBy: 3 } });
    expect(events[1].hint).toBeTruthy();
  });

  it("watch reports a new review and honours --ignore-self", async () => {
    const h = harness(() => {
      gh.comments = [{ id: 1, user: { login: "me" }, body: "my own reply", html_url: "u" }];
      gh.reviews = [
        {
          id: 9,
          user: { login: "alice" },
          state: "CHANGES_REQUESTED",
          body: "fix it",
          html_url: "u",
        },
      ];
    });
    expect(await run(["watch", PR, "--ignore-self", "--interval", "1s"], h.io)).toBe(0);
    expect(h.events().map((e) => e.type)).toEqual(["review_changes_requested"]);
  });

  it("watch exits 0 on merge even when filtering to other events", async () => {
    const h = harness(() => {
      gh.prState = "merged";
    });
    expect(await run(["watch", PR, "--events", "review_approved", "--interval", "1s"], h.io)).toBe(
      0,
    );
    expect(h.events().map((e) => e.type)).toEqual(["pr_merged"]);
  });

  it("watch exits 3 on timeout", async () => {
    const h = harness();
    expect(await run(["watch", PR, "--interval", "1s", "--timeout", "1ms"], h.io)).toBe(3);
    expect(h.out).toEqual([]);
  });

  it("text format is readable", async () => {
    const h = harness(() => {
      gh.comments = [{ id: 1, user: { login: "bob" }, body: "hello\nworld", html_url: "u" }];
    });
    await run(["watch", PR, "--format", "text", "--interval", "1s"], h.io);
    expect(h.out.join("")).toMatch(/^\[comment\] acme\/app#7 bob: hello\n {2}→ /);
  });

  it("exits 1 with a clear message when the PR does not exist", async () => {
    const h = harness();
    expect(await run(["status", "acme/app#999"], h.io)).toBe(1);
    expect(h.err.join("")).toContain("404");
  });

  it("handles a merged PR whose base branch was deleted", async () => {
    gh.prState = "merged";
    gh.baseDeleted = true;
    const h = harness();
    expect(await run(["status", PR], h.io)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({
      state: "merged",
      base: { sha: "base-at-merge" },
    });
    const w = harness();
    expect(await run(["watch", PR], w.io)).toBe(0);
    expect(w.events().map((e) => e.type)).toEqual(["pr_merged"]);
  });

  it("reports standing changes-requested feedback on a fresh start", async () => {
    gh.reviews = [
      {
        id: 3,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "add tests",
        html_url: "u",
      },
    ];
    const h = harness();
    expect(await run(["watch", PR], h.io)).toBe(0);
    expect(h.events()).toMatchObject([
      { type: "review_changes_requested", initial: true, data: { user: "alice" } },
    ]);
  });

  it("status includes review bodies and --full includes comments", async () => {
    gh.reviews = [
      {
        id: 3,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "add tests",
        html_url: "u",
      },
    ];
    gh.comments = [{ id: 1, user: { login: "bob" }, body: "hello", html_url: "u" }];
    const a = harness();
    await run(["status", PR], a.io);
    expect(JSON.parse(a.out.join("")).reviews[0]).toMatchObject({
      user: "alice",
      body: "add tests",
    });
    const b = harness();
    await run(["status", PR, "--full"], b.io);
    expect(JSON.parse(b.out.join("")).comments[0].body).toBe("hello");
  });

  it("warns when no token is available", async () => {
    const h = harness();
    h.io.env = { GITHUB_API_URL: gh.url, PATH: "/nonexistent" };
    await run(["status", PR], h.io);
    expect(h.err.join("")).toContain("no GitHub token found");
  });
});
