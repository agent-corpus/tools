import { type DiffOptions, diffSnapshots } from "./diff.js";
import { type EventType, type PrEvent, TERMINAL_EVENTS } from "./events.js";
import { GithubError } from "./github.js";
import { formatRef } from "./ref.js";
import { carryForward, type Snapshot } from "./snapshot.js";
import { loadState, saveState } from "./state.js";

export interface WatchOptions extends DiffOptions {
  fetchSnapshot: () => Promise<Snapshot>;
  intervalMs: number;
  /** 0 = wait forever. */
  timeoutMs: number;
  /** Keep running after events are emitted instead of exiting on the first batch. */
  follow: boolean;
  /** Only wake on / print these events. Terminal events always pass. */
  only: ReadonlySet<EventType> | null;
  stateFile?: string;
  onEvent: (event: PrEvent) => void;
  onLog?: (message: string) => void;
  /** Injectable for tests. Resolves early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowMs?: () => number;
  signal?: AbortSignal;
  maxConsecutiveFailures?: number;
}

export type WatchOutcome = "events" | "terminal" | "timeout" | "aborted";

export interface WatchResult {
  outcome: WatchOutcome;
  events: PrEvent[];
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

export async function watch(opts: WatchOptions): Promise<WatchResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const nowMs = opts.nowMs ?? Date.now;
  const log = opts.onLog ?? (() => {});
  const maxFailures = opts.maxConsecutiveFailures ?? 5;
  const prKey = formatRef(opts.ref);
  const deadline = opts.timeoutMs > 0 ? nowMs() + opts.timeoutMs : Number.POSITIVE_INFINITY;
  const emitted: PrEvent[] = [];

  let prev: Snapshot | null = opts.stateFile ? await loadState(opts.stateFile, prKey) : null;
  if (prev) log(`resumed from state file ${opts.stateFile}`);
  let failures = 0;

  while (!opts.signal?.aborted) {
    let waitMs = opts.intervalMs;
    try {
      const next = carryForward(prev, await opts.fetchSnapshot());
      failures = 0;

      const all = diffSnapshots(prev, next, opts);
      const events = all.filter(
        (e) => !opts.only || opts.only.has(e.type) || TERMINAL_EVENTS.includes(e.type),
      );
      for (const e of events) opts.onEvent(e);
      emitted.push(...events);
      prev = next;
      if (opts.stateFile) await saveState(opts.stateFile, prKey, next);

      if (events.some((e) => TERMINAL_EVENTS.includes(e.type))) {
        return { outcome: "terminal", events: emitted };
      }
      if (events.length > 0 && !opts.follow) return { outcome: "events", events: emitted };
    } catch (err) {
      if (err instanceof GithubError && err.fatal) throw err;
      failures++;
      if (failures >= maxFailures) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof GithubError && err.retryAfterMs !== undefined) {
        waitMs = err.retryAfterMs;
        log(`rate limited; waiting ${Math.round(waitMs / 1000)}s`);
      } else {
        log(`poll failed (${failures}/${maxFailures}): ${message}`);
        waitMs = Math.min(opts.intervalMs * 2 ** (failures - 1), 5 * 60_000);
      }
    }

    const remaining = deadline - nowMs();
    if (remaining <= 0) return { outcome: "timeout", events: emitted };
    await sleep(Math.min(waitMs, remaining), opts.signal);
    if (nowMs() >= deadline) return { outcome: "timeout", events: emitted };
  }
  return { outcome: "aborted", events: emitted };
}
