import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/duration.js";

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("30")).toBe(30_000);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("250ms")).toBe(250);
  });
  it("rejects invalid input", () => {
    expect(() => parseDuration("soon")).toThrow(/Invalid duration/);
    expect(() => parseDuration("-5s")).toThrow();
  });
});
