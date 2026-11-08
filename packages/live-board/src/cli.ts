#!/usr/bin/env node
import { args, interval, main, output, usage } from "@agent-corpus/tracker-core";
import { serve } from "./index.js";

await main(async () => {
  const { positionals, values } = args();
  if (values.home) process.env.TRACKER_HOME = values.home;
  if (positionals[0] && !["serve", "usage"].includes(positionals[0]))
    throw new Error("Use live-board usage");
  if (positionals[0] !== "serve") {
    usage("live-board", ["serve [--port 17999] [--interval seconds] [--home directory]"]);
    return;
  }
  const board = await serve(Number(values.port ?? 17999), interval(values.interval));
  output({ url: board.url });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void board.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});
