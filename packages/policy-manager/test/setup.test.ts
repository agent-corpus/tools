import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { hookConfig } from "../src/config.js";
import { setupHook } from "../src/setup.js";

const roots: string[] = [];
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "policy-hook-setup-"));
  roots.push(root);
  const installed = join(root, "installed", "dist", "cli.js");
  mkdirSync(dirname(installed), { recursive: true });
  writeFileSync(installed, "// Reviewed package fixture\n");
  return { root, installed, configDirectory: join(root, "profile") };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test.each(["claude", "codex", "copilot"] as const)(
  "%s setup installs deterministic hooks and is idempotent",
  (harness) => {
    const f = fixture();
    const a = setupHook(harness, f.installed, { configDirectory: f.configDirectory });
    const config = JSON.parse(readFileSync(a.configPath, "utf8"));
    expect(config.hooks).toBeDefined();
    const permissionEvent = harness === "copilot" ? "permissionRequest" : "PermissionRequest";
    const toolEvent = harness === "copilot" ? "preToolUse" : "PreToolUse";
    expect(config.hooks[permissionEvent]).toHaveLength(1);
    expect(config.hooks[toolEvent]).toHaveLength(1);
    expect(JSON.stringify(config)).toContain("--agent-corpus-policy-manager-hook");
    expect(JSON.stringify(config)).not.toContain("bypass");
    const before = readFileSync(a.configPath, "utf8");
    const b = setupHook(harness, f.installed, { configDirectory: f.configDirectory });
    expect(b.changed).toBe(false);
    expect(b.backupPath).toBeUndefined();
    expect(readFileSync(a.configPath, "utf8")).toBe(before);
    if (process.platform !== "win32") expect(statSync(a.configPath).mode & 0o777).toBe(0o600);
    if (harness === "codex") expect(a.nextSteps.join(" ")).toContain("/hooks");
  },
);
test.each(["claude", "codex", "copilot"] as const)(
  "%s preserves custom settings and backs up exact original bytes",
  (harness) => {
    const f = fixture();
    const event = harness === "copilot" ? "preToolUse" : "PreToolUse";
    const custom =
      harness === "copilot"
        ? { type: "command", exec: "custom-tool", args: ["check"] }
        : { matcher: "Bash", hooks: [{ type: "command", command: "custom-tool check" }] };
    const original = {
      ...(harness === "copilot" ? { version: 1 } : {}),
      permissions: { allow: ["Read"], deny: ["Delete"], defaultMode: "default" },
      custom: { setting: "preserve" },
      hooks: { [event]: [custom] },
    };
    const preview = setupHook(harness, f.installed, {
      configDirectory: f.configDirectory,
      dryRun: true,
    });
    mkdirSync(dirname(preview.configPath), { recursive: true });
    const bytes = JSON.stringify(original);
    writeFileSync(preview.configPath, bytes);
    const result = setupHook(harness, f.installed, { configDirectory: f.configDirectory });
    const updated = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(updated.permissions).toEqual(original.permissions);
    expect(updated.custom).toEqual(original.custom);
    expect(updated.hooks[event][0]).toEqual(custom);
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(bytes);
  },
);
test("dry run creates no files and exposes no existing permission data", () => {
  const f = fixture();
  const preview = setupHook("claude", f.installed, {
    configDirectory: f.configDirectory,
    dryRun: true,
  });
  expect(preview.changed).toBe(true);
  expect(existsSync(f.configDirectory)).toBe(false);
  mkdirSync(f.configDirectory);
  writeFileSync(
    join(f.configDirectory, "settings.json"),
    JSON.stringify({ env: { TOKEN: "private-setting" } }),
  );
  const next = setupHook("claude", f.installed, {
    configDirectory: f.configDirectory,
    dryRun: true,
  });
  expect(JSON.stringify(next)).not.toContain("private-setting");
  expect(readdirSync(f.configDirectory)).toEqual(["settings.json"]);
});
test("upgrades managed hooks while preserving mixed custom hook groups", () => {
  const f = fixture(),
    current = hookConfig("claude", f.installed) as {
      hooks: Record<string, { hooks: unknown[] }[]>;
    };
  const custom = { type: "command", command: "custom-check" };
  current.hooks.PreToolUse?.[0]?.hooks.unshift(custom);
  mkdirSync(f.configDirectory);
  const path = join(f.configDirectory, "settings.json");
  writeFileSync(path, JSON.stringify(current));
  const replacement = join(f.root, "updated", "dist", "cli.js");
  mkdirSync(dirname(replacement), { recursive: true });
  writeFileSync(replacement, "// Updated reviewed package fixture\n");
  setupHook("claude", replacement, { configDirectory: f.configDirectory });
  const result = JSON.parse(readFileSync(path, "utf8"));
  expect(result.hooks.PreToolUse[0].hooks).toEqual([custom]);
  expect(JSON.stringify(result)).not.toContain(f.installed);
  expect(JSON.stringify(result)).toContain(replacement);
});
test("refuses malformed settings without replacing them", () => {
  const f = fixture();
  mkdirSync(f.configDirectory);
  const path = join(f.configDirectory, "settings.json");
  writeFileSync(path, '{"incomplete":');
  expect(() => setupHook("claude", f.installed, { configDirectory: f.configDirectory })).toThrow(
    "invalid JSON",
  );
  expect(readFileSync(path, "utf8")).toBe('{"incomplete":');
  expect(readdirSync(f.configDirectory)).toEqual(["settings.json"]);
});
test("refuses a busy setup lock without changing settings", () => {
  const f = fixture();
  mkdirSync(f.configDirectory);
  writeFileSync(join(f.configDirectory, ".policy-manager-setup.lock"), "active");
  expect(() => setupHook("claude", f.installed, { configDirectory: f.configDirectory })).toThrow(
    "setup lock",
  );
  expect(readdirSync(f.configDirectory)).toEqual([".policy-manager-setup.lock"]);
});
test.skipIf(process.platform === "win32")("refuses settings symlinks", () => {
  const f = fixture();
  mkdirSync(f.configDirectory);
  const outside = join(f.root, "outside.json");
  writeFileSync(outside, "{}");
  symlinkSync(outside, join(f.configDirectory, "settings.json"));
  expect(() => setupHook("claude", f.installed, { configDirectory: f.configDirectory })).toThrow(
    "regular file",
  );
  expect(readFileSync(outside, "utf8")).toBe("{}");
});
test("refuses to activate mutable worktree code", () => {
  const f = fixture();
  expect(() => setupHook("codex", cli, { configDirectory: f.configDirectory })).toThrow(
    "outside Git checkouts",
  );
  expect(existsSync(f.configDirectory)).toBe(false);
});
test.each(["claude", "codex", "copilot"] as const)(
  "%s CLI alias supports dry-run previews without installing",
  (harness) => {
    const f = fixture();
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, `setup-hook-${harness}`, "--dry-run", "--config-dir", f.configDirectory],
        { encoding: "utf8" },
      ),
    );
    expect(result.harness).toBe(harness);
    expect(result.dryRun).toBe(true);
    expect(existsSync(f.configDirectory)).toBe(false);
  },
);
