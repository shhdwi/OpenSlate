/**
 * Probe nanoindex.nanonets.com to discover what's on the page so we can
 * plan a meaningful demo flow. Read-only inspection; no interactions
 * that would affect the page state.
 */

import { chromium } from "playwright-core";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  console.log("→ navigating to https://nanoindex.nanonets.com/demo");
  await page
    .goto("https://nanoindex.nanonets.com/demo", { waitUntil: "networkidle", timeout: 25_000 })
    .catch((e) => console.log("nav error:", e.message));
  await page.waitForTimeout(2500);

  console.log(`\nLanded on: ${page.url()}`);
  console.log(`Title: ${await page.title()}\n`);

  const surface = await page.evaluate(() => {
    const isVisible = (el: Element) => (el as HTMLElement).offsetParent !== null;
    const out: {
      kind: string;
      tag: string;
      text: string;
      type: string | null;
      id: string | null;
      placeholder: string | null;
      ariaLabel: string | null;
      href: string | null;
    }[] = [];

    // CTAs / buttons / links with meaningful text
    for (const el of Array.from(document.querySelectorAll("button, a"))) {
      if (!isVisible(el)) continue;
      const text = (el.textContent ?? "").trim();
      if (!text || text.length > 80) continue;
      out.push({
        kind: el.tagName.toLowerCase() === "button" ? "button" : "link",
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 60),
        type: (el as HTMLButtonElement).type ?? null,
        id: el.id || null,
        placeholder: null,
        ariaLabel: el.getAttribute("aria-label"),
        href: (el as HTMLAnchorElement).href ?? null,
      });
      if (out.length >= 30) break;
    }

    // Inputs
    for (const el of Array.from(document.querySelectorAll("input, textarea")).slice(0, 10)) {
      if (!isVisible(el)) continue;
      out.push({
        kind: "input",
        tag: el.tagName.toLowerCase(),
        text: "",
        type: (el as HTMLInputElement).type ?? null,
        id: el.id || null,
        placeholder: (el as HTMLInputElement).placeholder ?? null,
        ariaLabel: el.getAttribute("aria-label"),
        href: null,
      });
    }

    return out;
  });

  console.log("Visible surface:");
  for (const s of surface) {
    if (s.kind === "input") {
      console.log(
        `  input[type=${s.type}]  id=${s.id}  placeholder="${s.placeholder}"  aria="${s.ariaLabel}"`,
      );
    } else if (s.kind === "button") {
      console.log(`  button "${s.text}"  id=${s.id}  type=${s.type}`);
    } else {
      console.log(`  link "${s.text}"  href=${s.href}`);
    }
  }

  // Headings — gives us a sense of the page structure
  const headings = await page.evaluate(() =>
    Array.from(document.querySelectorAll("h1, h2, h3"))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .slice(0, 8)
      .map((el) => `${el.tagName}: ${(el.textContent ?? "").trim().slice(0, 80)}`),
  );
  console.log("\nHeadings:");
  for (const h of headings) console.log(`  ${h}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
