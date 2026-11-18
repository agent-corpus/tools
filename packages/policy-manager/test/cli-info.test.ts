import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const version = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version as string;
// An empty temp directory: the commands must not start or reach a session service.
const temp = mkdtempSync(join(tmpdir(), "cli-info-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
  });

describe("--version and --help need no session service", () => {
  test("--version prints the package version", () => {
    const out = run("--version");
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe(version);
    expect(out.stderr).toBe("");
  });

  test.each(["--help", "help"])("%s lists the subcommands", (flag) => {
    const out = run(flag);
    expect(out.status).toBe(0);
    for (const sub of ["hook", "approve", "setup-hook", "profile validate", "replay", "--version"])
      expect(out.stdout).toContain(sub);
    expect(out.stderr).not.toMatch(/Policy manager failed/);
  });

  test("nothing is written to the temp directory", () => {
    run("--version");
    run("--help");
    expect(readdirSync(temp)).toEqual([]);
  });
});
