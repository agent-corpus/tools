import { readFileSync } from "node:fs";
import { EVENT_CATALOG } from "./events.js";

export const EXIT_CODES = {
  0: "Success: events were emitted, the PR reached a terminal state, or the command finished.",
  1: "Runtime error (auth, network, PR not found, repeated API failures). Message on stderr.",
  2: "Usage error (bad flags or PR reference). Message on stderr.",
  3: "Timeout: --timeout elapsed and no matching event occurred. Not an error; re-run to keep waiting.",
  130: "Interrupted (SIGINT/SIGTERM).",
} as const;

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

export const HELP = `pr-watch — wait for something actionable to happen on a GitHub pull request.

Usage:
  pr-watch watch <pr> [options]    Block until events occur; print them as JSON lines.
  pr-watch status <pr> [options]   Print one JSON snapshot of the PR and exit.
  pr-watch usage [--json]          Full guide for coding agents (start here).
  pr-watch --version

<pr> is a PR URL, owner/repo#123, or a bare number (with --repo or an origin remote).

Run \`pr-watch usage\` for events, flags, exit codes, and recipes.`;

export function usageMarkdown(): string {
  const events = EVENT_CATALOG.map(
    (e) =>
      `- \`${e.type}\` — ${e.description}\n  - data: ${
        Object.keys(e.data).length
          ? Object.keys(e.data)
              .map((k) => `\`${k}\``)
              .join(", ")
          : "(none)"
      }\n  - suggested action: ${e.suggestedAction}`,
  ).join("\n");
  const codes = Object.entries(EXIT_CODES)
    .map(([code, meaning]) => `- \`${code}\` — ${meaning}`)
    .join("\n");

  return `# pr-watch ${version()} — usage guide for coding agents

pr-watch polls a GitHub pull request and **blocks until something actionable happens**, then
prints one JSON object per line (NDJSON) on stdout and exits. It is agent-agnostic: any agent
that can run a shell command can use it.

## Quick start

\`\`\`sh
# Needs a token: GITHUB_TOKEN / GH_TOKEN, or an authenticated \`gh\` CLI.
pr-watch watch https://github.com/OWNER/REPO/pull/123 --timeout 30m --ignore-self
\`\`\`

Typical agent loop:

1. Push your branch and open the PR.
2. Run \`pr-watch watch <pr> --timeout 30m --ignore-self --state-file .pr-watch/state.json\`
   (in the background if your harness supports it, otherwise in the foreground).
3. Read the event lines. Each has \`type\`, \`data\` and a \`hint\` describing a sensible next step.
4. Act (fetch/rebase, fix review comments, fix CI), push, then go back to step 2.
5. Stop when exit is caused by \`pr_merged\` or \`pr_closed\`.

Use \`--state-file\` so a new invocation compares against the previous run: anything that happened
while you were busy is reported immediately instead of being missed.

## Commands

- \`pr-watch watch <pr>\` — poll until events occur. Exits after the first batch unless \`--follow\`.
- \`pr-watch status <pr>\` — one-shot JSON summary (state, behindBy, conflicts, checks, latest review per reviewer).
- \`pr-watch usage [--json]\` — this guide; \`--json\` is a machine-readable manifest.

## Options (watch)

- \`--repo owner/name\` — needed only when <pr> is a bare number and cwd has no origin remote.
- \`--interval <dur>\` — poll interval, default \`60s\` (min \`1s\`). Forms: \`30s\`, \`5m\`, \`1h\`.
- \`--timeout <dur>\` — give up after this long (exit 3). Default: wait forever.
- \`--follow\` — keep streaming events instead of exiting after the first batch.
- \`--events a,b,c\` — only wake on these event types (terminal events always pass).
- \`--stale-after <n>\` — commits behind base that count as stale. Default \`1\`.
- \`--ignore-author <login>\` — ignore comments/reviews by this user (repeatable).
- \`--ignore-self\` — ignore the authenticated user (so your own replies do not wake you).
- \`--ignore-bots\` — ignore logins ending in \`[bot]\`.
- \`--state-file <path>\` — persist the last snapshot between runs.
- \`--format json|text\` — \`json\` (default, NDJSON) or \`text\` (one readable line per event).
- \`--api-url <url>\` — GitHub Enterprise API base (or env \`GITHUB_API_URL\`).

## Output

stdout carries only events, one JSON object per line:

\`\`\`json
{"type":"review_changes_requested","pr":"acme/app#123","at":"2026-01-01T12:00:00.000Z","data":{"id":1,"user":"alice","body":"Please add tests","url":"https://github.com/..."},"hint":"Read the review and its inline comments, ..."}
\`\`\`

\`"initial": true\` means the condition already held when watching started (e.g. already stale).
Progress and diagnostics go to stderr. Historical comments are not replayed; use \`status\` for the
current picture.

## Events

${events}

## Exit codes

${codes}

## Environment

- \`GITHUB_TOKEN\` / \`GH_TOKEN\` — API token (read access to the repo's pull requests and checks).
- \`GITHUB_API_URL\` — API base for GitHub Enterprise Server.

## Notes

- Each poll costs about 8 API requests; the default 60s interval uses roughly 500 of the 5000/hour limit.
- Rate limits are respected automatically; transient errors are retried before failing.
- Comments are truncated to 4000 characters in event data; follow \`data.url\` for the full text.
`;
}

export function usageManifest(): Record<string, unknown> {
  return {
    name: "pr-watch",
    version: version(),
    summary: "Block until something actionable happens on a GitHub PR; emit NDJSON events.",
    commands: {
      watch:
        "pr-watch watch <pr> [--interval 60s] [--timeout 30m] [--follow] [--events a,b] [--stale-after 1] [--ignore-author u] [--ignore-self] [--ignore-bots] [--state-file path] [--format json|text] [--repo o/n] [--api-url url]",
      status: "pr-watch status <pr> [--repo o/n] [--api-url url]",
      usage: "pr-watch usage [--json]",
    },
    events: EVENT_CATALOG,
    exitCodes: EXIT_CODES,
    env: ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_API_URL"],
  };
}
