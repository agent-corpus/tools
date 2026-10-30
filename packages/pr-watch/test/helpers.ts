import type { DiffOptions } from "../src/diff.js";
import type { Snapshot } from "../src/snapshot.js";

export const REF = { owner: "acme", repo: "app", number: 7 };

export function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    takenAt: "2026-01-01T00:00:00.000Z",
    title: "Add thing",
    url: "https://github.com/acme/app/pull/7",
    author: "dev",
    state: "open",
    draft: false,
    mergedBy: null,
    baseRef: "main",
    baseSha: "base1",
    headRef: "feature",
    headSha: "head1",
    behindBy: 0,
    aheadBy: 1,
    conflicting: false,
    mergeableState: "clean",
    checks: { state: "success", failing: [] },
    reviews: [],
    reviewComments: [],
    comments: [],
    ...overrides,
  };
}

export function diffOpts(overrides: Partial<DiffOptions> = {}): DiffOptions {
  return {
    ref: REF,
    staleAfter: 1,
    ignoreAuthors: new Set(),
    ignoreBots: false,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
