import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlan, planSchema, transact } from "./index.js";

const unit = { id: "a", title: "A", status: "planned" };
const plan = { version: 1, id: "demo", name: "Demo", units: [unit] };
describe("tracking plan validation", () => {
  it("reads exactly one fenced contract and defaults uncertain approvals to pending", () => {
    expect(
      parsePlan(`Narrative\n\`\`\`tracking-plan\n${JSON.stringify(plan)}\n\`\`\`\n`).units[0]
        ?.approval,
    ).toBe("pending");
    expect(() => parsePlan("No structured plan")).toThrow("exactly one");
    const block = `\`\`\`tracking-plan\n${JSON.stringify(plan)}\n\`\`\`\n`;
    expect(() => parsePlan(block + block)).toThrow("exactly one");
  });
  it.each([
    { ...plan, version: 2 },
    { ...plan, unexpected: true },
    { ...plan, units: [unit, unit] },
    { ...plan, units: [{ ...unit, dependsOn: ["missing"] }] },
    {
      ...plan,
      units: [
        { ...unit, dependsOn: ["b"] },
        { ...unit, id: "b", dependsOn: ["a"] },
      ],
    },
    { ...plan, units: [{ ...unit, approval: "approved" }] },
    { ...plan, units: [{ ...unit, evidence: ["javascript:alert(1)"] }] },
  ])("rejects invalid intent without guessing: %j", (input) => {
    expect(planSchema.safeParse(input).success).toBe(false);
  });
});
it("serializes concurrent writers and leaves readable durable state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tracker-lock-"));
  try {
    await Promise.all(
      Array.from({ length: 12 }, () => transact("counter.json", 0, (n) => n + 1, dir)),
    );
    expect(JSON.parse(await readFile(join(dir, "counter.json"), "utf8"))).toBe(12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
