#!/usr/bin/env node
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { GithubError } from "@agent-corpus/pr-watch";
import {
  args,
  interval,
  main,
  output,
  readState,
  transact,
  usage,
} from "@agent-corpus/tracker-core";
import { type IssueSnapshot, observeIssue } from "./index.js";

await main(async () => {
  const { positionals, values } = args();
  if (values.home) process.env.TRACKER_HOME = values.home;
  const [cmd, url] = positionals;
  if (cmd === "usage" || !cmd) {
    usage("issue-watch", ["status URL", "watch URL [--follow] [--interval seconds]"]);
    return;
  }
  if (!url || !["status", "watch"].includes(cmd)) throw new Error("Use issue-watch usage");
  const delay = interval(values.interval);
  const file = `issue-${createHash("sha256").update(url).digest("hex")}.json`;
  let previous = await readState<IssueSnapshot | null>(file, null);
  for (;;) {
    let current: IssueSnapshot;
    try {
      current = await observeIssue(url);
    } catch (e) {
      if (
        cmd === "status" ||
        (!values.follow && !(e instanceof GithubError && e.retryAfterMs !== undefined))
      )
        throw e;
      output({
        type: "source_error",
        source: url,
        error: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      });
      await sleep(Math.max(delay, e instanceof GithubError ? (e.retryAfterMs ?? delay) : delay));
      continue;
    }
    if (cmd === "status") {
      output(current);
      return;
    }
    if (!previous || previous.revision !== current.revision) {
      output({
        type: previous ? "issue_changed" : "issue_observed",
        source: url,
        at: current.observedAt,
        snapshot: current,
      });
      await transact(file, current, () => current);
      if (!values.follow) return;
    }
    previous = current;
    await sleep(delay);
  }
});
