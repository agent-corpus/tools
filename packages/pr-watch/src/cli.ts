#!/usr/bin/env node
import { run } from "./main.js";

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

// Exiting on EPIPE keeps `pr-watch ... | head -1` from throwing.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const code = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  signal: controller.signal,
  cwd: process.cwd(),
});
process.exitCode = code;
