import { execFileSync } from "node:child_process";

/**
 * Process ancestry, for `approve`: a person approves from a terminal of their own, which is not
 * a descendant of the agent harness. An agent's commands (a PTY from Codex `exec_command`,
 * `script -q /dev/null ...`) all run below the harness process, so `approve` refuses when one of
 * its ancestors is the harness of the session it would approve, or any agent harness.
 *
 * Limits: this is a check on the process tree, by the same user. A process that leaves the tree
 * (a double fork or `setsid` reparents it to init or launchd, `osascript` asking Terminal to run
 * a command, a scheduled job) is not below the harness any more. Those commands name `approve`
 * too, which the session's guard sends to a person, but an agent able to run arbitrary code as
 * the user is not contained by either check.
 */

export interface ProcessInfo {
  ppid: number;
  command: string;
}

/** A harness program name, and the npm packages and install paths they run from. */
const HARNESS_PROGRAM = /^(?:claude|codex|copilot)(?:\.exe|\.cmd)?$/i;
const HARNESS_PACKAGE =
  /@anthropic-ai[\\/]claude-code|@openai[\\/]codex|@github[\\/]copilot|[\\/]claude[\\/]versions[\\/]/i;
/** Whether a command line runs Claude Code, Codex or Copilot, as a binary or an npm package. */
export function harnessCommand(command: string): boolean {
  const program = command.trim().split(/\s+/)[0] ?? "";
  return HARNESS_PROGRAM.test(program.split(/[\\/]/).pop() ?? "") || HARNESS_PACKAGE.test(command);
}
const SHELL =
  /^(?:-?(?:sh|bash|zsh|dash|ksh|fish|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe))$/i;

/** Every process's parent and command line, or undefined when they cannot be read. */
export function processTable(timeoutMs = 15_000): Map<number, ProcessInfo> | undefined {
  try {
    const out =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
            ],
            {
              encoding: "utf8",
              timeout: timeoutMs,
              maxBuffer: 64 * 1024 * 1024,
              windowsHide: true,
            },
          )
        : execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
            encoding: "utf8",
            timeout: Math.min(timeoutMs, 5_000),
            maxBuffer: 64 * 1024 * 1024,
          });
    const table = new Map<number, ProcessInfo>();
    for (const line of out.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
      if (match) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] ?? "" });
    }
    return table.size ? table : undefined;
  } catch {
    return undefined;
  }
}

/** The ancestors of `pid`, nearest first, up to the root (at most 128). */
export function ancestors(pid: number, table: Map<number, ProcessInfo>): number[] {
  const found: number[] = [];
  let current = table.get(pid)?.ppid;
  while (current && current > 0 && !found.includes(current) && found.length < 128) {
    found.push(current);
    current = table.get(current)?.ppid;
  }
  return found;
}

/**
 * The harness process a hook runs under: the nearest ancestor that looks like a harness, or else
 * the nearest one that is not a shell (harnesses run hooks through `sh -c`).
 */
export function harnessOf(pid: number, table: Map<number, ProcessInfo>): number | undefined {
  const chain = ancestors(pid, table);
  const named = chain.find((p) => harnessCommand(table.get(p)?.command ?? ""));
  if (named) return named;
  return chain.find((p) => {
    const program = (table.get(p)?.command ?? "").trim().split(/\s+/)[0] ?? "";
    return !SHELL.test(program.split(/[\\/]/).pop() ?? "");
  });
}

/**
 * Why `approve` must not run here, or undefined: one of its ancestors is the session's harness
 * process, or any agent harness. Unknown ancestry fails closed.
 */
export function insideAgent(
  harnessPid: number | undefined,
  pid = process.pid,
  table = processTable(),
): string | undefined {
  if (!table)
    return "The process tree could not be read, so approve cannot tell your terminal from an agent's. Nothing was approved.";
  for (const ancestor of ancestors(pid, table))
    if (ancestor === harnessPid || harnessCommand(table.get(ancestor)?.command ?? ""))
      return "approve is running inside an agent session (below a claude, codex or copilot process). Run it in a terminal of your own, outside the agent. Nothing was approved.";
  return undefined;
}
