#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  args,
  interval,
  main,
  output,
  parsePlan,
  planSchema,
  usage,
} from "@agent-corpus/tracker-core";
import { dashboard, markSeen, refresh, register, remove, state } from "./index.js";

await main(async () => {
  const { positionals, values } = args();
  if (values.home) process.env.TRACKER_HOME = values.home;
  const [cmd, source] = positionals;
  if (cmd === "validate" && values.file) {
    const body = await readFile(values.file, "utf8");
    const plan = body.trimStart().startsWith("{")
      ? planSchema.parse(JSON.parse(body))
      : parsePlan(body);
    output({ valid: true, plan });
  } else if (cmd === "add" && source) {
    output({ id: await register(source) });
    await refresh();
    output(await dashboard());
  } else if (cmd === "remove" && source) {
    await remove(source);
    output({ removed: source });
  } else if (cmd === "seen") {
    await markSeen();
    output({ ok: true });
  } else if (cmd === "refresh") {
    await refresh();
    output(await dashboard());
  } else if (cmd === "status" || cmd === "brief") {
    output(await dashboard());
  } else if (cmd === "watch" || cmd === "events") {
    const delay = interval(values.interval);
    const seen = new Set<string>();
    for (;;) {
      await refresh();
      if (cmd === "watch") output(await dashboard());
      else
        for (const e of (await state()).events.slice().reverse())
          if (!seen.has(e.id) && (!values.since || e.at > values.since)) {
            seen.add(e.id);
            output(e);
          }
      if (!values.follow) return;
      await sleep(delay);
    }
  } else if (cmd && cmd !== "usage") throw new Error("Use project-watch usage");
  else
    usage("project-watch", [
      "validate --file PLAN_JSON_OR_MARKDOWN",
      "add ISSUE_URL|PLAN_FILE",
      "remove ID",
      "refresh",
      "status",
      "brief",
      "seen",
      "events [--since ISO] [--follow]",
      "watch --follow [--interval seconds]",
    ]);
});
