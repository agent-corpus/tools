import { parseArgs } from "node:util";
import { parseDuration } from "./duration.js";
import { EVENT_TYPES, type EventType, isEventType, type PrEvent } from "./events.js";
import { GithubClient, GithubError, resolveToken } from "./github.js";
import { formatRef, type PrRef, resolvePrRef } from "./ref.js";
import { type Snapshot, takeSnapshot } from "./snapshot.js";
import { HELP, usageManifest, usageMarkdown, version } from "./usage.js";
import { watch } from "./watch.js";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  cwd?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

class UsageError extends Error {}

const OPTIONS = {
  repo: { type: "string" },
  interval: { type: "string", default: "60s" },
  timeout: { type: "string" },
  follow: { type: "boolean", default: false },
  events: { type: "string" },
  "stale-after": { type: "string", default: "1" },
  "ignore-author": { type: "string", multiple: true },
  "ignore-self": { type: "boolean", default: false },
  "ignore-bots": { type: "boolean", default: false },
  "state-file": { type: "string" },
  format: { type: "string", default: "json" },
  "api-url": { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

/** Run the CLI; resolves to a process exit code. Never throws. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`pr-watch: ${err.message}\nRun \`pr-watch usage\` for help.\n`);
      return 2;
    }
    io.stderr(`pr-watch: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version) {
    io.stdout(`${version()}\n`);
    return 0;
  }
  if (!command || values.help || command === "help") {
    io.stdout(`${HELP}\n`);
    return 0;
  }
  if (command === "usage") {
    io.stdout(values.json ? `${JSON.stringify(usageManifest(), null, 2)}\n` : usageMarkdown());
    return 0;
  }
  if (command !== "watch" && command !== "status") {
    throw new UsageError(`unknown command "${command}"`);
  }
  if (rest.length !== 1) throw new UsageError(`${command} takes exactly one PR reference`);

  const ref = await resolvePrRef(rest[0] as string, { repo: values.repo, cwd: io.cwd }).catch(
    (err: Error) => {
      throw new UsageError(err.message);
    },
  );
  const client = new GithubClient({
    token: await resolveToken(io.env),
    apiUrl: values["api-url"] ?? io.env.GITHUB_API_URL,
    fetch: io.fetch,
  });

  if (command === "status") {
    io.stdout(`${JSON.stringify(summarize(ref, await takeSnapshot(client, ref)), null, 2)}\n`);
    return 0;
  }
  return runWatch(ref, client, values, io);
}

async function runWatch(
  ref: PrRef,
  client: GithubClient,
  values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"],
  io: Io,
): Promise<number> {
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
  };

  const intervalMs = guard(() => parseDuration(values.interval as string));
  if (intervalMs < 1000) throw new UsageError("--interval must be at least 1s");
  const timeoutMs = values.timeout ? guard(() => parseDuration(values.timeout as string)) : 0;
  const staleAfter = Number(values["stale-after"]);
  if (!Number.isInteger(staleAfter) || staleAfter < 1) {
    throw new UsageError("--stale-after must be a positive integer");
  }
  if (values.format !== "json" && values.format !== "text") {
    throw new UsageError('--format must be "json" or "text"');
  }

  let only: Set<EventType> | null = null;
  if (values.events) {
    only = new Set();
    for (const name of values.events
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!isEventType(name)) {
        throw new UsageError(`unknown event "${name}". Valid: ${EVENT_TYPES.join(", ")}`);
      }
      only.add(name);
    }
  }

  const ignoreAuthors = new Set((values["ignore-author"] ?? []).map((u) => u.toLowerCase()));
  if (values["ignore-self"]) {
    try {
      const me = await client.get<{ login: string }>("/user");
      ignoreAuthors.add(me.login.toLowerCase());
    } catch {
      io.stderr(
        "pr-watch: warning: could not resolve authenticated user; --ignore-self has no effect\n",
      );
    }
  }

  const render = values.format === "text" ? formatText : JSON.stringify;
  const result = await watch({
    ref,
    fetchSnapshot: () => takeSnapshot(client, ref),
    intervalMs,
    timeoutMs,
    follow: values.follow as boolean,
    only,
    staleAfter,
    ignoreAuthors,
    ignoreBots: values["ignore-bots"] as boolean,
    stateFile: values["state-file"],
    onEvent: (event) => io.stdout(`${render(event)}\n`),
    onLog: (msg) => io.stderr(`pr-watch: ${msg}\n`),
    signal: io.signal,
    sleep: io.sleep,
  });

  switch (result.outcome) {
    case "timeout":
      io.stderr(`pr-watch: timed out after ${values.timeout} with no matching events\n`);
      return 3;
    case "aborted":
      return 130;
    default:
      return 0;
  }
}

function formatText(e: PrEvent): string {
  const d = e.data as { user?: string; body?: string; path?: string; line?: number | null };
  const who = d.user ? ` ${d.user}` : "";
  const where = d.path ? ` ${d.path}${d.line ? `:${d.line}` : ""}` : "";
  const body = d.body ? `: ${d.body.split("\n")[0]?.slice(0, 120)}` : "";
  return `[${e.type}] ${e.pr}${e.initial ? " (initial)" : ""}${who}${where}${body}\n  → ${e.hint}`;
}

/** Compact view of a snapshot for `status`. */
export function summarize(ref: PrRef, s: Snapshot): Record<string, unknown> {
  const latest = new Map<string, string>();
  for (const r of s.reviews) {
    if (r.state === "COMMENTED" && latest.has(r.user)) continue;
    if (r.state !== "DISMISSED") latest.set(r.user, r.state);
    else latest.delete(r.user);
  }
  return {
    pr: formatRef(ref),
    url: s.url,
    title: s.title,
    author: s.author,
    state: s.state,
    draft: s.draft,
    base: { ref: s.baseRef, sha: s.baseSha },
    head: { ref: s.headRef, sha: s.headSha },
    behindBy: s.behindBy,
    aheadBy: s.aheadBy,
    conflicting: s.conflicting,
    mergeableState: s.mergeableState,
    checks: s.checks,
    reviews: [...latest].map(([user, state]) => ({ user, state })),
    counts: {
      reviews: s.reviews.length,
      inlineComments: s.reviewComments.length,
      comments: s.comments.length,
    },
  };
}

export { GithubError };
