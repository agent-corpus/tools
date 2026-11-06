import { GithubClient } from "@agent-corpus/pr-watch";
import { expect, it } from "vitest";
import { issueRef, observeIssue } from "./index.js";

it.each([
  "http://github.com/a/b/issues/1",
  "https://attacker.test/a/b/issues/1",
  "https://github.com/a/b/pull/1",
  "https://github.com/a/b/issues/0",
])("refuses non-issue URLs: %s", (url) => {
  expect(() => issueRef(url)).toThrow();
});
it("detects comment-only changes while ignoring observation time", async () => {
  let body = "First";
  const client = new GithubClient({
    fetch: async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("/comments")
            ? [
                {
                  id: 1,
                  body,
                  html_url: "https://github.com/a/b/issues/1#comment",
                  updated_at: "2026-01-01",
                },
              ]
            : {
                title: "Plan",
                body: "Body",
                state: "open",
                updated_at: "2026-01-01",
                html_url: "https://github.com/a/b/issues/1",
                labels: [],
              },
        ),
        { status: 200 },
      ),
  });
  const first = await observeIssue("https://github.com/a/b/issues/1", client);
  const second = await observeIssue(first.url, client);
  expect(second.revision).toBe(first.revision);
  body = "Changed";
  expect((await observeIssue(first.url, client)).revision).not.toBe(first.revision);
});
