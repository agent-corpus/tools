import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function formatRef(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

const URL_RE = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const SHORT_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** Parse `https://github.com/o/r/pull/1`, `o/r#1`. Returns null if not recognised. */
export function parsePrRef(input: string): PrRef | null {
  const m = URL_RE.exec(input.trim()) ?? SHORT_RE.exec(input.trim());
  if (!m) return null;
  return { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) };
}

/** Extract owner/repo from a git remote URL (https or ssh form). */
export function parseRemoteUrl(url: string): { owner: string; repo: string } | null {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

/**
 * Resolve a user-supplied PR argument. A bare number (`123` or `#123`) is
 * resolved against `repo` (`owner/name`) or the cwd's `origin` remote.
 */
export async function resolvePrRef(
  input: string,
  opts: { repo?: string; cwd?: string } = {},
): Promise<PrRef> {
  const full = parsePrRef(input);
  if (full) return full;

  const bare = /^#?(\d+)$/.exec(input.trim());
  if (!bare) {
    throw new Error(
      `Cannot parse PR reference "${input}". Use a PR URL, owner/repo#123, or a number with --repo.`,
    );
  }
  const number = Number(bare[1]);

  let slug: { owner: string; repo: string } | null = null;
  if (opts.repo) {
    const m = /^([^/]+)\/([^/]+)$/.exec(opts.repo);
    if (!m) throw new Error(`--repo must look like owner/name, got "${opts.repo}".`);
    slug = { owner: m[1] as string, repo: m[2] as string };
  } else {
    try {
      const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
        cwd: opts.cwd,
      });
      slug = parseRemoteUrl(stdout);
    } catch {
      /* fall through to the error below */
    }
  }
  if (!slug) {
    throw new Error(
      `PR number "${input}" given without a repository. Pass --repo owner/name or run inside a clone with an origin remote.`,
    );
  }
  return { ...slug, number };
}
