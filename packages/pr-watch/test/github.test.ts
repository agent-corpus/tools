import { describe, expect, it } from "vitest";
import { GithubClient, GithubError } from "../src/github.js";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

const rejection = (p: Promise<unknown>): Promise<GithubError> =>
  p.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (e: GithubError) => e,
  );

describe("GithubClient", () => {
  it("sends auth and API headers", async () => {
    let seen: Headers | undefined;
    const client = new GithubClient({
      token: "tok",
      apiUrl: "https://ghe.example/api/v3/",
      fetch: async (url, init) => {
        seen = new Headers(init?.headers);
        expect(String(url)).toBe("https://ghe.example/api/v3/x");
        return json({ ok: true });
      },
    });
    await client.get("/x");
    expect(seen?.get("authorization")).toBe("Bearer tok");
    expect(seen?.get("accept")).toContain("github");
  });

  it("follows pagination, including envelope keys", async () => {
    const pages: Record<string, Response> = {
      "https://api.github.com/x?per_page=100": json(
        { items: [1, 2] },
        {
          headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
        },
      ),
      "https://api.github.com/x?page=2": json({ items: [3] }),
    };
    const client = new GithubClient({ fetch: async (url) => pages[String(url)] as Response });
    expect(await client.paginate("/x", "items")).toEqual([1, 2, 3]);
  });

  it("maps rate limiting to a retryable error", async () => {
    const client = new GithubClient({
      fetch: async () =>
        json({ message: "rate limit" }, { status: 403, headers: { "retry-after": "12" } }),
    });
    const err = await rejection(client.get("/x"));
    expect(err).toBeInstanceOf(GithubError);
    expect(err.retryAfterMs).toBe(12_000);
    expect(err.fatal).toBe(false);
  });

  it("treats 404 as fatal and hints at missing tokens", async () => {
    const client = new GithubClient({
      fetch: async () => json({ message: "Not Found" }, { status: 404 }),
    });
    const err = await rejection(client.get("/x"));
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/no token found/);
  });

  it("treats 5xx as retryable", async () => {
    const client = new GithubClient({ fetch: async () => json({}, { status: 502 }) });
    expect((await rejection(client.get("/x"))).fatal).toBe(false);
  });
});
