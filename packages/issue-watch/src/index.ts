import { createHash } from "node:crypto";
import { GithubClient, resolveToken } from "@agent-corpus/pr-watch";
export function issueRef(input: string) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(input);
  if (!m?.[1] || !m[2] || !m[3] || !Number.isSafeInteger(Number(m[3])))
    throw new Error("Expected a github.com issue URL");
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}
export interface IssueSnapshot {
  url: string;
  title: string;
  body: string;
  state: string;
  updatedAt: string;
  observedAt: string;
  revision: string;
  labels: string[];
  comments: { id: number; body: string; html_url: string; updated_at: string }[];
}
export async function observeIssue(url: string, client?: GithubClient): Promise<IssueSnapshot> {
  const r = issueRef(url);
  const c = client ?? new GithubClient({ token: await resolveToken() });
  const path = `/repos/${r.owner}/${r.repo}/issues/${r.number}`;
  const issue = await c.get<{
    html_url: string;
    title: string;
    body: string | null;
    state: string;
    updated_at: string;
    labels: { name: string }[];
    pull_request?: unknown;
  }>(path);
  if (issue.pull_request) throw new Error("Source is a pull request, not a tracking issue");
  const comments = await c.paginate<IssueSnapshot["comments"][number]>(`${path}/comments`);
  const data = {
    url: issue.html_url,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    updatedAt: issue.updated_at,
    labels: issue.labels.map((l) => l.name).sort(),
    comments,
  };
  return {
    ...data,
    observedAt: new Date().toISOString(),
    revision: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
  };
}
