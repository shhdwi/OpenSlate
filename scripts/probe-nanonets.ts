/**
 * Probe nanonets's signup page structure to find real selectors. Not part
 * of the product; lives in scripts/ as one-off discovery tooling.
 *
 * Strategy: navigate, click the most likely "Get started" CTA, dump where
 * we landed plus the form fields we find on that page.
 */

import { chromium } from "playwright-core";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  console.log("→ navigating directly to https://accounts.nanonets.com/signup");
  await page.goto("https://accounts.nanonets.com/signup", { waitUntil: "networkidle", timeout: 20_000 });
  await page.waitForTimeout(1500);

  // Dump all visible inputs + buttons + CTA-text anchors WITHOUT clicking
  // (so we don't trigger a navigation that destroys the context).
  const surface = await page.evaluate(() => {
    const out: {
      kind: "input" | "button" | "cta";
      tag: string;
      type: string | null;
      name: string | null;
      id: string | null;
      placeholder: string | null;
      ariaLabel: string | null;
      text: string;
      href: string | null;
      visible: boolean;
    }[] = [];

    const isVisible = (el: Element) => (el as HTMLElement).offsetParent !== null;

    for (const el of Array.from(document.querySelectorAll("input"))) {
      out.push({
        kind: "input",
        tag: "input",
        type: el.type ?? null,
        name: el.name ?? null,
        id: el.id || null,
        placeholder: el.placeholder ?? null,
        ariaLabel: el.getAttribute("aria-label"),
        text: "",
        href: null,
        visible: isVisible(el),
      });
    }
    for (const el of Array.from(document.querySelectorAll("button"))) {
      out.push({
        kind: "button",
        tag: "button",
        type: (el as HTMLButtonElement).type ?? null,
        name: (el as HTMLButtonElement).name ?? null,
        id: el.id || null,
        placeholder: null,
        ariaLabel: el.getAttribute("aria-label"),
        text: (el.textContent ?? "").trim().slice(0, 80),
        href: null,
        visible: isVisible(el),
      });
    }
    for (const el of Array.from(document.querySelectorAll("a"))) {
      const text = (el.textContent ?? "").trim();
      if (!/sign|continue|next|email|create/i.test(text)) continue;
      out.push({
        kind: "cta",
        tag: "a",
        type: null,
        name: null,
        id: el.id || null,
        placeholder: null,
        ariaLabel: el.getAttribute("aria-label"),
        text: text.slice(0, 80),
        href: (el as HTMLAnchorElement).href ?? null,
        visible: isVisible(el),
      });
    }
    return out;
  });

  console.log(`\nLanded on: ${page.url()}\n`);
  console.log("Surface (visible only):");
  for (const s of surface) {
    if (!s.visible) continue;
    if (s.kind === "input") {
      console.log(
        `  input[type=${s.type}] name=${s.name} id=${s.id} placeholder="${s.placeholder}" aria="${s.ariaLabel}"`,
      );
    } else if (s.kind === "button") {
      console.log(`  button "${s.text}" type=${s.type} aria="${s.ariaLabel}"`);
    } else {
      console.log(`  a "${s.text}" href=${s.href}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
