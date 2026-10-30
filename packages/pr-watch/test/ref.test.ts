import { describe, expect, it } from "vitest";
import { parsePrRef, parseRemoteUrl, resolvePrRef } from "../src/ref.js";

describe("parsePrRef", () => {
  it("parses URLs and short refs", () => {
    expect(parsePrRef("https://github.com/a/b/pull/12")).toEqual({
      owner: "a",
      repo: "b",
      number: 12,
    });
    expect(parsePrRef("https://ghe.corp/a/b/pull/12/files#x")).toEqual({
      owner: "a",
      repo: "b",
      number: 12,
    });
    expect(parsePrRef("a/b#3")).toEqual({ owner: "a", repo: "b", number: 3 });
  });
  it("rejects garbage", () => {
    expect(parsePrRef("nope")).toBeNull();
    expect(parsePrRef("https://github.com/a/b/issues/1")).toBeNull();
  });
});

describe("parseRemoteUrl", () => {
  it.each([
    "https://github.com/a/b.git",
    "https://github.com/a/b",
    "git@github.com:a/b.git",
    "ssh://git@github.com/a/b.git",
  ])("parses %s", (url) => {
    expect(parseRemoteUrl(url)).toEqual({ owner: "a", repo: "b" });
  });
});

describe("resolvePrRef", () => {
  it("resolves a bare number with --repo", async () => {
    expect(await resolvePrRef("#9", { repo: "a/b" })).toEqual({ owner: "a", repo: "b", number: 9 });
  });
  it("rejects a malformed --repo", async () => {
    await expect(resolvePrRef("9", { repo: "nope" })).rejects.toThrow(/owner\/name/);
  });
  it("rejects unparseable input", async () => {
    await expect(resolvePrRef("hello")).rejects.toThrow(/Cannot parse/);
  });
});
