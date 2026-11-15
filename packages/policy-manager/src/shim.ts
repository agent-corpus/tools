import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/** Marks a `pm` launcher this package wrote, with the version that wrote it. */
export const SHIM_MARKER = "agent-corpus-policy-manager-shim";

export interface ShimStatus {
  path: string;
  /** `current`: managed and runs this CLI; `older`/`newer`: managed by another version;
   *  `foreign`: a `pm` this package did not write; `absent`. */
  state: "current" | "older" | "newer" | "foreign" | "absent";
  onPath: boolean;
}

/** The directory the launcher lives in: `~/.local/bin`, or `%LOCALAPPDATA%\agent-corpus\bin`. */
export function shimDirectory(): string {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agent-corpus", "bin")
    : join(homedir(), ".local", "bin");
}

export function shimPath(directory: string): string {
  return join(directory, process.platform === "win32" ? "pm.cmd" : "pm");
}

/** The package version of an installed CLI (`<package>/dist/cli.js`). */
export function cliVersion(cliPath: string): string {
  const pkg = JSON.parse(readFileSync(join(dirname(cliPath), "..", "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version))
    throw new Error("The installed CLI has no readable version");
  return pkg.version;
}

export function shimText(cliPath: string, version: string): string {
  if (process.platform === "win32")
    return [
      "@echo off",
      `rem ${SHIM_MARKER} version=${version}`,
      `"${process.execPath}" "${cliPath}" %*`,
      "",
    ].join("\r\n");
  return [
    "#!/usr/bin/env node",
    `// ${SHIM_MARKER} version=${version}`,
    'const { spawnSync } = require("node:child_process");',
    `const result = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n");
}

const compare = (a: string, b: string) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

function onPath(directory: string): boolean {
  const target = resolve(directory);
  return (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .some((entry) => entry && resolve(entry) === target);
}

export function inspectShim(directory: string, cliPath: string, version: string): ShimStatus {
  const path = shimPath(directory);
  const status = (state: ShimStatus["state"]): ShimStatus => ({
    path,
    state,
    onPath: onPath(directory),
  });
  if (!existsSync(path)) return status("absent");
  let text: string;
  try {
    if (!lstatSync(path).isFile()) return status("foreign");
    text = readFileSync(path, "utf8");
  } catch {
    return status("foreign");
  }
  const found = text.match(new RegExp(`${SHIM_MARKER} version=(\\d+\\.\\d+\\.\\d+)`))?.[1];
  if (!found) return status("foreign");
  const order = compare(found, version);
  if (order > 0) return status("newer");
  if (order < 0) return status("older");
  return status(text === shimText(cliPath, version) ? "current" : "older");
}

/**
 * Installs or updates the managed `pm` launcher. Never replaces a `pm` this package did not
 * write, or one written by a newer version. Returns whether it changed anything.
 */
export function installShim(
  directory: string,
  cliPath: string,
  version: string,
  dryRun: boolean,
): ShimStatus & { changed: boolean } {
  const before = inspectShim(directory, cliPath, version);
  if (before.state !== "absent" && before.state !== "older") return { ...before, changed: false };
  if (dryRun) return { ...before, changed: true };
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const temp = join(directory, `.pm.${randomUUID()}.tmp`);
  const fd = openSync(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o755,
  );
  try {
    writeFileSync(fd, shimText(cliPath, version));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (process.platform !== "win32") chmodSync(temp, 0o755);
    renameSync(temp, before.path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return { ...inspectShim(directory, cliPath, version), changed: true };
}
