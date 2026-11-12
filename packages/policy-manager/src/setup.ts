import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { hookConfig, managedHookFlag } from "./config.js";
import type { Request } from "./types.js";

type JsonObject = Record<string, unknown>;
export interface SetupOptions {
  configDirectory?: string;
  dryRun?: boolean;
}
export interface SetupResult {
  harness: Request["harness"];
  configPath: string;
  dryRun: boolean;
  changed: boolean;
  backupPath?: string;
  managedHooks: JsonObject;
  nextSteps: string[];
}
export class SetupError extends Error {}
function object(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readConfig(path: string): string | undefined {
  let fd: number;
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new SetupError(
        "The hook settings file must be a regular file owned by the current user.",
      );
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 2 * 1024 * 1024 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new SetupError("The hook settings file is unsafe or too large.");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function owned(hook: unknown, harness: Request["harness"], event: string): boolean {
  if (!object(hook) || hook.type !== "command") return false;
  if (harness === "copilot")
    return (
      Array.isArray(hook.args) &&
      hook.args[1] === "hook" &&
      hook.args[2] === harness &&
      hook.args.at(-1) === managedHookFlag
    );
  return (
    typeof hook.command === "string" &&
    hook.command.endsWith(` hook ${harness} ${event} ${managedHookFlag}`)
  );
}
function merge(config: JsonObject, harness: Request["harness"], desired: JsonObject): JsonObject {
  if (config.hooks !== undefined && !object(config.hooks))
    throw new SetupError("Existing hooks must be an object.");
  if (harness === "copilot" && config.version !== undefined && config.version !== 1)
    throw new SetupError("This Copilot hook file uses an unsupported version.");
  const hooks: JsonObject = Object.create(null);
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) throw new SetupError("Existing hook events must contain arrays.");
    const remaining: unknown[] = [];
    for (const group of groups) {
      if (harness === "copilot") {
        if (!owned(group, harness, event)) remaining.push(group);
        continue;
      }
      if (!object(group) || !Array.isArray(group.hooks))
        throw new SetupError("Existing hook groups must contain hook arrays.");
      const leaves = group.hooks.filter((hook) => !owned(hook, harness, event));
      if (leaves.length === group.hooks.length) remaining.push(group);
      else if (leaves.length) remaining.push({ ...group, hooks: leaves });
    }
    if (remaining.length) hooks[event] = remaining;
  }
  for (const [event, groups] of Object.entries(desired.hooks as JsonObject))
    hooks[event] = [...((hooks[event] as unknown[]) ?? []), ...(groups as unknown[])];
  return { ...config, ...(harness === "copilot" ? { version: 1 } : {}), hooks };
}
function inCheckout(path: string): boolean {
  let current = dirname(path);
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
function writePrivate(path: string, text: string): void {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function setupHook(
  harness: Request["harness"],
  cliPath: string,
  options: SetupOptions = {},
): SetupResult {
  if (!["claude", "codex", "copilot"].includes(harness))
    throw new SetupError("Select claude, codex, or copilot.");
  const installedCli = realpathSync(cliPath);
  if (!lstatSync(installedCli).isFile())
    throw new SetupError("The installed CLI entrypoint must be a regular file.");
  if (inCheckout(installedCli) && !options.dryRun)
    throw new SetupError(
      "Install the reviewed package outside Git checkouts before enabling permission hooks. Use --dry-run to preview source builds.",
    );
  const defaults = {
    claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    codex: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    copilot: process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
  };
  const root = resolve(options.configDirectory ?? defaults[harness]);
  if (existsSync(root) && lstatSync(root).isSymbolicLink())
    throw new SetupError("The harness configuration directory cannot be a symbolic link.");
  const target =
    harness === "claude"
      ? join(root, "settings.json")
      : harness === "codex"
        ? join(root, "hooks.json")
        : join(root, "hooks", "policy-manager.json");
  const desired = hookConfig(harness, installedCli);
  const dryRun = options.dryRun ?? false;
  const nextSteps = [
    "Start a new harness session to load the hooks.",
    ...(harness === "codex"
      ? [
          "Open /hooks and explicitly review and trust the installed hooks. Setup does not grant hook trust, and Codex skips hooks it has not trusted.",
          "Codex trusts the command text, not the code behind it: an upgrade at the same CLI path keeps trust, so review a new version before upgrading in place. A changed command (a new install path or Node binary) is skipped until you trust it again.",
          "Codex does not support ask in PreToolUse, so a decision that needs a human is returned as a deny and the command does not run; approving it in chat does not unblock it.",
        ]
      : []),
    "Native sandbox controls and existing permission rules remain in effect.",
  ];
  const prepare = () => {
    const original = readConfig(target);
    let config: unknown = {};
    try {
      config = original === undefined ? {} : JSON.parse(original);
    } catch {
      throw new SetupError(
        "The existing hook settings file contains invalid JSON. No settings were replaced.",
      );
    }
    if (!object(config)) throw new SetupError("Existing hook settings must be a JSON object.");
    const result = merge(config, harness, desired);
    const changed = JSON.stringify(config) !== JSON.stringify(result);
    return { original, text: `${JSON.stringify(result, null, 2)}\n`, changed };
  };
  if (dryRun)
    return {
      harness,
      configPath: target,
      dryRun,
      changed: prepare().changed,
      managedHooks: desired.hooks as JsonObject,
      nextSteps: [
        ...(inCheckout(installedCli)
          ? ["Install the reviewed package outside Git checkouts before applying this preview."]
          : []),
        ...nextSteps,
      ],
    };
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (process.getuid && parentStat.uid !== process.getuid())
  )
    throw new SetupError("The hook settings directory must belong to the current user.");
  const lock = join(parent, ".policy-manager-setup.lock");
  let lockFd: number;
  try {
    lockFd = openSync(
      lock,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new SetupError(
        "Another setup operation or a stale setup lock exists. Inspect it before retrying.",
      );
    throw error;
  }
  const temp = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const prepared = prepare();
    if (!prepared.changed)
      return {
        harness,
        configPath: target,
        dryRun,
        changed: false,
        managedHooks: desired.hooks as JsonObject,
        nextSteps,
      };
    writePrivate(temp, prepared.text);
    if (readConfig(target) !== prepared.original)
      throw new SetupError(
        "The settings changed during setup. Retry without overwriting the concurrent edit.",
      );
    let backupPath: string | undefined;
    if (prepared.original !== undefined) {
      backupPath = `${target}.policy-manager-${randomUUID()}.bak`;
      writePrivate(backupPath, prepared.original);
    }
    renameSync(temp, target);
    return {
      harness,
      configPath: target,
      dryRun,
      changed: true,
      ...(backupPath ? { backupPath } : {}),
      managedHooks: desired.hooks as JsonObject,
      nextSteps,
    };
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
