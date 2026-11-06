#!/usr/bin/env node
import { type ArtifactKind, scaffold } from "./index.js";

const args = process.argv.slice(2);
const usage =
  "agent-scaffold <agent|skill> <name> <description> [root]\nCreates silhouettes first. Refuses existing artifacts. Add content only to the returned canonical file.";
try {
  if (args[0] === "usage" || !args.length)
    console.log(args.includes("--json") ? JSON.stringify({ usage }) : usage);
  else {
    const [kind, name, description, root = process.cwd()] = args;
    if (!kind || !name || !description) throw new Error(usage);
    console.log(JSON.stringify(await scaffold(root, kind as ArtifactKind, name, description)));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Scaffold failed");
  process.exitCode = 1;
}
