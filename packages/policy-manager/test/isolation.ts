// Runs before every test file. Tests never read or change the user's real harness settings or
// policy profile, and never run a real classifier CLI: the configuration directories point at an
// empty private directory, and `claude`, `codex` and `copilot` on PATH are stubs that fail.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pm-test-env-"));
const bin = join(root, "bin");
mkdirSync(bin);
for (const name of ["claude", "codex", "copilot"]) {
  writeFileSync(join(bin, name), "#!/bin/sh\necho 'classifier stub' >&2\nexit 1\n");
  chmodSync(join(bin, name), 0o755);
}
for (const [key, dir] of [
  ["XDG_CONFIG_HOME", "config"],
  ["CLAUDE_CONFIG_DIR", "claude"],
  ["CODEX_HOME", "codex"],
  ["COPILOT_HOME", "copilot"],
] as const) {
  mkdirSync(join(root, dir));
  process.env[key] = join(root, dir);
}
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.AGENT_CORPUS_POLICY_CLASSIFIER;
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
