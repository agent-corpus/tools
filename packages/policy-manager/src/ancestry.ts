import { execFileSync } from "node:child_process";

/**
 * Process ancestry, for `approve`: a backstop, not the defense. The defense is the session's guard,
 * which sends any agent command that runs the policy-manager CLI to a person as a hard,
 * never-grantable item. This check catches what slips past it in the ordinary way: `approve` run
 * below an agent harness (a PTY from Codex `exec_command`, `script -q /dev/null ...`) is refused
 * when one of its ancestors is the harness process of any live policy session, or any process
 * that is Claude Code, Codex or Copilot.
 *
 * Limits: this is a check on the process tree, by the same user. A process that leaves the tree
 * (`( ... & )`, a double fork or `setsid` reparents it to init or launchd; `osascript` asking
 * Terminal to run a command; a scheduled job) is not below the harness any more. An agent able to
 * run arbitrary code as the user is not contained by this check.
 */

export interface ProcessInfo {
  ppid: number;
  command: string;
  /** Creation time (Windows FILETIME, as a number), where the table reports one. */
  created?: number;
}

/** A harness program: Claude Code, Codex or Copilot, a native binary or a desktop app. */
const HARNESS_PROGRAM = /^(?:claude|codex|copilot)(?:\.exe|\.cmd|\.js|\.mjs)?$/i;
/** Where the npm packages of the harness CLIs live, each up to a path boundary. */
const HARNESS_PACKAGE =
  /[\\/](?:@anthropic-ai[\\/]claude-code|@openai[\\/]codex|@github[\\/]copilot|claude[\\/]versions)[\\/]/i;
const NODE = /^(?:node|nodejs|bun)(?:\.exe)?$/i;

/**
 * Whether a command line runs Claude Code, Codex or Copilot: its program (argv[0]) is one, or it is
 * Node running one (argv[1]: `node /opt/homebrew/bin/claude`, `node .../@openai/codex/bin/codex.js`).
 * Only those two words are read, each up to a path boundary, so `@github/copilot-sdk` or a shell
 * whose arguments mention these names does not count.
 */
export function harnessCommand(command: string): boolean {
  const [argv0 = "", argv1 = ""] = command.trim().split(/\s+/);
  const is = (word: string) =>
    HARNESS_PROGRAM.test(word.split(/[\\/]/).pop() ?? "") || HARNESS_PACKAGE.test(word);
  return is(argv0) || (NODE.test(argv0.split(/[\\/]/).pop() ?? "") && is(argv1));
}

/** Every process's parent and command line, or undefined when they cannot be read. */
export function processTable(timeoutMs = 15_000): Map<number, ProcessInfo> | undefined {
  try {
    const windows = process.platform === "win32";
    const out = windows
      ? execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) $($_.CommandLine)" }',
          ],
          { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        )
      : execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
          encoding: "utf8",
          timeout: Math.min(timeoutMs, 5_000),
          maxBuffer: 64 * 1024 * 1024,
        });
    const table = new Map<number, ProcessInfo>();
    for (const line of out.split(/\r?\n/)) {
      const match = windows
        ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(line)
        : /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
      if (!match) continue;
      table.set(
        Number(match[1]),
        windows
          ? {
              ppid: Number(match[2]),
              created: Number(match[3]) || undefined,
              command: match[4] ?? "",
            }
          : { ppid: Number(match[2]), command: match[3] ?? "" },
      );
    }
    return table.size ? table : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ancestors of `pid`, nearest first, up to the root (at most 128). Windows does not reparent
 * orphans, so a dead parent's PID can be reused by an unrelated process: where creation times are
 * known, a "parent" created after its child ends the chain.
 */
export function ancestors(pid: number, table: Map<number, ProcessInfo>): number[] {
  const found: number[] = [];
  let child = table.get(pid);
  let current = child?.ppid;
  while (current && current > 0 && !found.includes(current) && found.length < 128) {
    const parent = table.get(current);
    if (parent?.created && child?.created && parent.created > child.created) break;
    found.push(current);
    child = parent;
    current = parent?.ppid;
  }
  return found;
}

/** The harness process a hook runs under: its nearest ancestor that is a harness, if any. */
export function harnessOf(pid: number, table: Map<number, ProcessInfo>): number | undefined {
  return ancestors(pid, table).find((p) => harnessCommand(table.get(p)?.command ?? ""));
}

/**
 * Why `approve` must not run here, or undefined: one of its ancestors is the harness process of a
 * live policy session (`harnessPids`), or any Claude Code, Codex or Copilot process. Unknown
 * ancestry fails closed.
 */
export function insideAgent(
  harnessPids: Iterable<number>,
  pid = process.pid,
  table = processTable(),
): string | undefined {
  if (!table)
    return process.platform === "win32"
      ? "The process tree could not be read (PowerShell or Get-CimInstance is blocked here, for example by Constrained Language Mode or AppLocker), so approve cannot tell your terminal from an agent's and cannot approve anything on this machine. Nothing was approved."
      : "The process tree could not be read (ps failed), so approve cannot tell your terminal from an agent's. Nothing was approved.";
  const known = new Set(harnessPids);
  for (const ancestor of ancestors(pid, table))
    if (known.has(ancestor) || harnessCommand(table.get(ancestor)?.command ?? ""))
      return "approve is running inside an agent session: below a claude, codex or copilot process, including a terminal inside the Claude or Codex desktop app. Run it in a terminal of your own, outside the agent. Nothing was approved.";
  return undefined;
}
