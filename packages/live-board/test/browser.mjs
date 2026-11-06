import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refresh, register } from "@agent-corpus/project-watch";
import { chromium } from "@playwright/test";
import { serve } from "../dist/index.js";

const dir = await mkdtemp(join(tmpdir(), "live-board-browser-"));
process.env.TRACKER_HOME = join(dir, "state");
for (const [id, name, total] of [
  ["website", "Website refresh", 5],
  ["portal", "Developer portal", 3],
  ["release", "Release automation", 4],
]) {
  const plan = {
    version: 1,
    id,
    name,
    description: "Synthetic browser fixture.",
    units: Array.from({ length: total }, (_, i) => ({
      id: `unit-${i}`,
      title: `Unit ${i + 1}`,
      status: i < 2 ? "done" : "planned",
      approval: i < 2 ? "not-required" : "pending",
    })),
  };
  const file = join(dir, `${id}.json`);
  await writeFile(file, JSON.stringify(plan));
  await register(file);
}
await refresh();
const app = await serve(0, 5000);

import assert from "node:assert/strict";

const browser = await chromium
  .launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  })
  .catch(async (error) => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  });
const page = await browser.newPage({
  viewport: { width: 1512, height: 1100 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function checkContrast(label) {
  const result = await page.evaluate(() => {
    const rgba = (value) => {
      const parts = value.match(/[\d.]+/g)?.map(Number);
      return parts?.length >= 3 ? [...parts.slice(0, 3), parts[3] ?? 1] : [0, 0, 0, 0];
    };
    const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const luminance = (color) =>
      color
        .map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratios = [];
    for (const el of document.querySelectorAll("body *")) {
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(" ")
        .trim();
      if (!text || !el.getClientRects().length || el.closest("svg, script, style")) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const ancestors = [];
      for (let parent = el; parent; parent = parent.parentElement) ancestors.unshift(parent);
      let bg = [255, 255, 255];
      for (const parent of ancestors) bg = over(rgba(getComputedStyle(parent).backgroundColor), bg);
      const fg = over(rgba(style.color), bg),
        a = luminance(fg),
        b = luminance(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(style.fontSize),
        bold = Number(style.fontWeight) >= 700;
      const threshold = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      ratios.push({
        text: text.slice(0, 65),
        size,
        ratio: Number(ratio.toFixed(2)),
        threshold,
        color: style.color,
        classes: el.className,
      });
    }
    return {
      minimum: Math.min(...ratios.map((r) => r.ratio)),
      minimumSize: Math.min(...ratios.map((r) => r.size)),
      smallText: ratios.filter((r) => r.size < 16),
      count: ratios.length,
      failures: ratios.filter((r) => r.ratio < r.threshold),
    };
  });
  console.log(
    `Contrast ${label}: ${result.count} text elements, minimum ${result.minimum}:1`,
    JSON.stringify(result.failures),
  );
  console.log(
    `Reading size ${label}: minimum ${result.minimumSize}px`,
    JSON.stringify(result.smallText),
  );
  assert.equal(result.smallText.length, 0, `Text below 16px on ${label}`);
  assert.equal(result.failures.length, 0, `Text contrast failed on ${label}`);
}
try {
  const response = await page.goto(app.url, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200);
  await page.locator(".project-card").first().waitFor();
  assert.equal(await page.locator(".project-card").count(), 3);
  await checkContrast("overview");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  if (process.env.TRACKER_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.TRACKER_SCREENSHOT_DIR, "overview.png"),
      fullPage: true,
    });
  await page.locator(".project-card").first().click();
  assert.equal(await page.locator(".live-plan").first().locator(".unit").count(), 5);
  await checkContrast("project detail");
  if (process.env.TRACKER_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.TRACKER_SCREENSHOT_DIR, "detail.png"),
      fullPage: true,
    });
  const fixture = join(dir, "website.json");
  const original = await readFile(fixture, "utf8");
  const changed = JSON.parse(original);
  changed.name = "Live update received";
  await writeFile(fixture, JSON.stringify(changed));
  await page
    .getByRole("heading", { name: "Live update received", exact: true })
    .waitFor({ timeout: 15000 });
  await writeFile(fixture, "invalid JSON");
  await page
    .getByText("Source unavailable or invalid.", { exact: true })
    .waitFor({ timeout: 15000 });
  assert.equal(await page.locator(".live-plan").first().locator(".unit").count(), 5);
  await writeFile(fixture, original);
  await page
    .getByRole("heading", { name: "Website refresh", exact: true })
    .waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Track a project", exact: true }).last().click();
  await page.getByRole("dialog").waitFor();
  await page.getByLabel("GitHub issue URL").fill("https://example.com/not-github");
  await page.getByRole("button", { name: "Track project", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await checkContrast("add project dialog");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await page.locator(".brand-button").click();
  await page.getByLabel("Search projects").fill("release");
  assert.equal(await page.locator(".project-card").count(), 1);
  await page.getByLabel("Search projects").fill("");
  for (const [width, height] of [
    [1024, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await checkContrast(`${width}px layout`);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    );
    if (process.env.TRACKER_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.TRACKER_SCREENSHOT_DIR, `layout-${width}.png`),
        fullPage: true,
      });
  }
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("button", { name: /Needs you/ }).click();
  assert.equal(await page.locator(".attention-item").count(), 6);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real SSE update, invalid source retains last plan, recovery, search, dialog validation, mobile navigation, no overflow, no runtime errors.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
