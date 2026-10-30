import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Set when GitHub asked us to back off (rate limit / abuse detection). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GithubError";
  }

  /** Errors that retrying will not fix: bad credentials, missing PR, no access. */
  get fatal(): boolean {
    return this.retryAfterMs === undefined && [400, 401, 403, 404, 410, 422].includes(this.status);
  }
}

export interface GithubClientOptions {
  token?: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

export const DEFAULT_API_URL = "https://api.github.com";

/** Token from GITHUB_TOKEN / GH_TOKEN, falling back to `gh auth token`. */
export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 5000, env });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export class GithubClient {
  private readonly apiUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: GithubClientOptions = {}) {
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? fetch;
  }

  async get<T>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.apiUrl + pathOrUrl;
    const { body } = await this.request(url);
    return body as T;
  }

  /** Follow `Link: rel="next"` pages. `itemsKey` is for envelope responses (e.g. check_runs). */
  async paginate<T>(path: string, itemsKey?: string): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    let url: string | undefined = `${this.apiUrl}${path}${sep}per_page=100`;
    const items: T[] = [];
    for (let page = 0; url && page < 50; page++) {
      const { body, next } = await this.request(url);
      const batch = itemsKey ? (body as Record<string, unknown>)[itemsKey] : body;
      if (Array.isArray(batch)) items.push(...(batch as T[]));
      url = next;
    }
    return items;
  }

  private async request(url: string): Promise<{ body: unknown; next?: string }> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "agent-corpus-pr-watch",
    };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;

    const res = await this.doFetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw await toError(res, Boolean(this.opts.token));
    const link = res.headers.get("link");
    const next = link ? /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] : undefined;
    return { body: await res.json(), next };
  }
}

async function toError(res: Response, authenticated: boolean): Promise<GithubError> {
  let detail = "";
  try {
    detail = ((await res.json()) as { message?: string }).message ?? "";
  } catch {
    /* body was not JSON */
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  const retryAfter = res.headers.get("retry-after");
  const reset = res.headers.get("x-ratelimit-reset");

  let retryAfterMs: number | undefined;
  if (res.status === 429 || (res.status === 403 && (remaining === "0" || retryAfter))) {
    if (retryAfter) retryAfterMs = Number(retryAfter) * 1000;
    else if (reset) retryAfterMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
    else retryAfterMs = 60_000;
  }

  let message = `GitHub API ${res.status} ${res.statusText} for ${res.url}: ${detail}`.trim();
  if (res.status === 401) message += " (check GITHUB_TOKEN / `gh auth login`)";
  if (res.status === 404 && !authenticated) {
    message +=
      " (no token found: private repos return 404; set GITHUB_TOKEN or run `gh auth login`)";
  }
  return new GithubError(message, res.status, retryAfterMs);
}
