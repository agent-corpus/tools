import type { GithubClient } from "./github.js";
import type { PrRef } from "./ref.js";

export type CheckState = "none" | "pending" | "success" | "failure";

export interface ReviewItem {
  id: number;
  user: string;
  state: string;
  body: string;
  url: string;
  submittedAt: string | null;
}

export interface ReviewCommentItem {
  id: number;
  user: string;
  path: string;
  line: number | null;
  body: string;
  url: string;
  inReplyTo: number | null;
}

export interface CommentItem {
  id: number;
  user: string;
  body: string;
  url: string;
}

/** Everything `pr-watch` knows about a PR at one instant. */
export interface Snapshot {
  takenAt: string;
  title: string;
  url: string;
  author: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  mergedBy: string | null;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  behindBy: number;
  aheadBy: number;
  /** null while GitHub is still computing mergeability. */
  conflicting: boolean | null;
  mergeableState: string;
  checks: { state: CheckState; failing: string[] };
  reviews: ReviewItem[];
  reviewComments: ReviewCommentItem[];
  comments: CommentItem[];
}

const BODY_LIMIT = 4000;
const clip = (s: string | null | undefined): string => {
  const text = s ?? "";
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…[truncated]` : text;
};

interface User {
  login?: string;
}
interface ApiPull {
  title: string;
  html_url: string;
  user: User | null;
  state: string;
  merged: boolean;
  draft?: boolean;
  merged_by?: User | null;
  mergeable: boolean | null;
  mergeable_state: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}
interface ApiReview {
  id: number;
  user: User | null;
  state: string;
  body: string | null;
  html_url: string;
  submitted_at?: string | null;
}
interface ApiReviewComment {
  id: number;
  user: User | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
  body: string;
  html_url: string;
  in_reply_to_id?: number;
}
interface ApiComment {
  id: number;
  user: User | null;
  body: string;
  html_url: string;
}
interface ApiCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}
interface ApiCombinedStatus {
  total_count: number;
  statuses: { context: string; state: string }[];
}

const login = (u: User | null | undefined): string => u?.login ?? "ghost";
const seg = (s: string): string => s.split("/").map(encodeURIComponent).join("/");

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);
const PASSED_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Collapse check runs and legacy commit statuses into one state. */
export function aggregateChecks(
  runs: ApiCheckRun[],
  statuses: ApiCombinedStatus["statuses"],
): Snapshot["checks"] {
  const failing: string[] = [];
  let pending = false;
  for (const run of runs) {
    if (run.status !== "completed") pending = true;
    else if (run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion)) failing.push(run.name);
    else if (!run.conclusion || !PASSED_CONCLUSIONS.has(run.conclusion)) pending = true;
  }
  for (const s of statuses) {
    if (s.state === "failure" || s.state === "error") failing.push(s.context);
    else if (s.state === "pending") pending = true;
  }
  const total = runs.length + statuses.length;
  const state: CheckState =
    total === 0 ? "none" : failing.length > 0 ? "failure" : pending ? "pending" : "success";
  return { state, failing: [...new Set(failing)].sort() };
}

export async function takeSnapshot(client: GithubClient, ref: PrRef): Promise<Snapshot> {
  const repo = `/repos/${seg(ref.owner)}/${seg(ref.repo)}`;
  const pull = await client.get<ApiPull>(`${repo}/pulls/${ref.number}`);

  const state: Snapshot["state"] = pull.merged
    ? "merged"
    : pull.state === "closed"
      ? "closed"
      : "open";
  const headSha = pull.head.sha;

  const [baseSha, reviews, reviewComments, comments, runs, combined] = await Promise.all([
    // A merged/closed PR's base branch may have been deleted; its recorded base is enough.
    state === "open"
      ? client
          .get<{ commit: { sha: string } }>(`${repo}/branches/${seg(pull.base.ref)}`)
          .then((b) => b.commit.sha)
      : Promise.resolve(pull.base.sha),
    client.paginate<ApiReview>(`${repo}/pulls/${ref.number}/reviews`),
    client.paginate<ApiReviewComment>(`${repo}/pulls/${ref.number}/comments`),
    client.paginate<ApiComment>(`${repo}/issues/${ref.number}/comments`),
    client.paginate<ApiCheckRun>(`${repo}/commits/${headSha}/check-runs`, "check_runs"),
    client.get<ApiCombinedStatus>(`${repo}/commits/${headSha}/status?per_page=100`),
  ]);

  let behindBy = 0;
  let aheadBy = 0;
  if (state === "open") {
    const cmp = await client.get<{ ahead_by: number; behind_by: number }>(
      `${repo}/compare/${baseSha}...${headSha}?per_page=1`,
    );
    behindBy = cmp.behind_by;
    aheadBy = cmp.ahead_by;
  }

  return {
    takenAt: new Date().toISOString(),
    title: pull.title,
    url: pull.html_url,
    author: login(pull.user),
    state,
    draft: pull.draft ?? false,
    mergedBy: pull.merged_by ? login(pull.merged_by) : null,
    baseRef: pull.base.ref,
    baseSha,
    headRef: pull.head.ref,
    headSha,
    behindBy,
    aheadBy,
    conflicting: pull.mergeable === null ? null : !pull.mergeable,
    mergeableState: pull.mergeable_state,
    checks: aggregateChecks(runs, combined.statuses),
    reviews: reviews
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({
        id: r.id,
        user: login(r.user),
        state: r.state,
        body: clip(r.body),
        url: r.html_url,
        submittedAt: r.submitted_at ?? null,
      })),
    reviewComments: reviewComments.map((c) => ({
      id: c.id,
      user: login(c.user),
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      body: clip(c.body),
      url: c.html_url,
      inReplyTo: c.in_reply_to_id ?? null,
    })),
    comments: comments.map((c) => ({
      id: c.id,
      user: login(c.user),
      body: clip(c.body),
      url: c.html_url,
    })),
  };
}

/** GitHub reports `mergeable: null` while it recomputes; keep the last known answer. */
export function carryForward(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (prev && next.conflicting === null && next.state === "open") {
    return { ...next, conflicting: prev.conflicting };
  }
  return next;
}
