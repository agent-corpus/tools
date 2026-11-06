import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { scaffold } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
test.each(["agent", "skill"] as const)(
  "%s has one canonical body and six references",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "scaffold-test-"));
    roots.push(root);
    const result = await scaffold(root, kind, "example", "Portable example");
    expect(result.files).toHaveLength(7);
    for (const file of result.files.filter((p) => p !== result.canonical))
      expect(await readFile(join(root, file), "utf8")).toContain(result.canonical);
    await expect(scaffold(root, kind, "example", "Another body")).rejects.toThrow("Refusing");
    expect(await readFile(join(root, result.canonical), "utf8")).toContain("Portable example");
  },
);
test("rejects traversal before writing", async () => {
  await expect(scaffold(tmpdir(), "agent", "../bad", "bad")).rejects.toThrow();
});
