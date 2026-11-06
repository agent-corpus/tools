#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { args, main, output, usage } from "@agent-corpus/tracker-core";
import { report, reports } from "./index.js";

await main(async () => {
  const { positionals, values } = args();
  if (values.home) process.env.TRACKER_HOME = values.home;
  if (positionals[0] === "list") {
    output(await reports());
    return;
  }
  if (positionals[0] === "put" && values.file) {
    output(await report(JSON.parse(await readFile(values.file, "utf8"))));
    return;
  }
  if (positionals[0] && positionals[0] !== "usage") throw new Error("Use task-report usage");
  usage("task-report", ["put --file report.json", "list"]);
});
