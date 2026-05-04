/**
 * Debug: take a plain screenshot of /demo at various zoom levels so we can
 * see what cropping actually looks like before we throw it through the
 * polish pipeline.
 */

import path from "node:path";
import { chromium } from "playwright-core";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  console.log("→ navigating to /demo");
  await page.goto("https://nanoindex.nanonets.com/demo", {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  await page.waitForTimeout(3000);

  const out = path.resolve("/Users/shhdwi/Motion/openslate/demos/debug");
  await import("node:fs/promises").then((fs) => fs.mkdir(out, { recursive: true }));

  console.log("snapping zoom=1.0");
  await page.screenshot({ path: path.join(out, "zoom-100.png") });

  console.log("snapping zoom=1.25 (current default in smoke)");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1.25";
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "zoom-125.png") });

  console.log("snapping zoom=0.85 (pulled back)");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "0.85";
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "zoom-85.png") });

  await browser.close();
  console.log("\nWrote debug screenshots to demos/debug/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
