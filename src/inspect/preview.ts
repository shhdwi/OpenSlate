/**
 * Page-inspection primitives. The MCP layer + the CLI both call into here.
 *
 * Why this exists: agents (Claude Code / Cursor / Codex) need to discover
 * what's clickable on a page WITHOUT the human authoring CSS selectors.
 * `preview` opens the URL headlessly, walks the page, and returns a
 * structured snapshot of every interactive element with a ranked-best
 * stable selector per element. The agent reads this and builds a plan
 * with verified selectors instead of guessing.
 *
 * Trade-offs in v1:
 *   - text-only output (no annotated screenshot — agent reasons from JSON)
 *   - stateless: each `previewAfter` re-runs prior actions from scratch
 *     (~1.5–3s per call). Session-based API will come in v2 if latency
 *     becomes a problem in real use.
 *   - strict element filter (ARIA roles + native interactive tags). Things
 *     bound to onClick handlers via `cursor: pointer` only are skipped —
 *     they're a noise generator and sites that need them can be coaxed via
 *     `previewAfter` after a hover.
 */

import { type Browser, type Page, chromium } from "playwright-core";
import type { PlanStep } from "../plan/types.js";

export interface PreviewOptions {
  url: string;
  viewport?: { width: number; height: number };
  /**
   * Settle time after `networkidle`. Hosted sites finish networkidle while
   * hero fonts / animations are still resolving; without a settle, the
   * snapshot can capture intermediate states. Default 1500ms (matches the
   * recorder's POST_NAV_SETTLE_MS so preview state ≈ recorder state).
   */
  settle_ms?: number;
}

export interface PreviewAfterOptions extends PreviewOptions {
  /**
   * Actions to run after navigation, before snapshotting. Used to expose
   * popup state — autocomplete dropdowns, modal dialogs, post-click form
   * states. Re-runs from scratch on each call (stateless).
   */
  prior_actions: PlanStep[];
}

export interface PreviewElement {
  /** Sequential id within this snapshot. Stable for THIS call only. */
  id: number;
  /** ARIA role or normalized native tag role. */
  role: string;
  /**
   * Accessible name — the user-facing label the agent should match
   * against the user's description. Sourced from aria-label / labelledby
   * / visible text / placeholder / alt, in that order.
   */
  name: string;
  /** Best stable selector; recorder-compatible. */
  selector: string;
  /** Optional fallback if `selector` misses at execute time. */
  fallback_selector?: string;
  /** Bounding box in viewport pixels. */
  bbox: { x: number; y: number; w: number; h: number };
  /** True if currently within the viewport (no scroll needed). */
  in_viewport: boolean;
  /** For text inputs. */
  placeholder?: string;
  /** For text inputs. */
  value?: string;
}

export interface PreviewResult {
  /** Final URL after redirects. */
  url_after_load: string;
  viewport: { width: number; height: number };
  page_title: string;
  /** Heuristic: did we detect a consent/cookie banner that may block clicks? */
  has_consent_banner: boolean;
  elements: PreviewElement[];
  /**
   * Hints for the agent — UI patterns we detected that may need a
   * `preview_after` follow-up. E.g. "combobox at id 3 — type to see options"
   */
  notes: string[];
}

/**
 * Page-side script that walks the DOM and produces a clean element list.
 * Runs inside Chromium via `page.evaluate`. Self-contained — no imports
 * from Node-side code possible.
 */
function pageSideSnapshot() {
  const VW = window.innerWidth;
  const VH = window.innerHeight;

  // Strict filter: ARIA-roleed elements + native interactive tags.
  // Excluded by design: anything click-handler-bound via cursor:pointer
  // (noise) and elements with role="presentation" (semantically hidden).
  const sels = [
    "a[href]",
    "button",
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='option']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='textbox']",
    "[role='combobox']",
    "[role='switch']",
    "[role='searchbox']",
    "[role='listitem']",
    "[contenteditable='true']",
  ];
  const candidates = Array.from(document.querySelectorAll(sels.join(", ")));

  function visibleName(el: Element): string {
    // 1. aria-label
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    // 2. aria-labelledby → resolve
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref?.textContent) return ref.textContent.trim();
    }
    // 3. <label> association for inputs
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.labels && el.labels.length > 0 && el.labels[0]) {
        const lt = el.labels[0].textContent;
        if (lt && lt.trim()) return lt.trim();
      }
    }
    // 4. visible text content (collapsed, capped)
    const txt = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (txt) return txt.slice(0, 80);
    // 5. placeholder
    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return ph.trim();
    // 6. alt for images
    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
    return "";
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const t = (el as HTMLInputElement).type;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return tag;
  }

  function isVisible(el: Element, r: DOMRect): boolean {
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (Number.parseFloat(cs.opacity) < 0.01) return false;
    return true;
  }

  function nthSelector(el: Element): string {
    // Robust positional fallback — `tag:nth-of-type(n)` chained from
    // nearest ancestor with an id. Avoids the long-chain selector that
    // breaks on minor DOM diffs.
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && parts.length < 6) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) {
        sel = `#${CSS.escape(cur.id)}`;
        parts.unshift(sel);
        return parts.join(" > ");
      }
      const sibs = cur.parentElement
        ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur!.tagName)
        : [];
      if (sibs.length > 1) {
        const idx = sibs.indexOf(cur) + 1;
        sel += `:nth-of-type(${idx})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function rankSelector(el: Element, name: string, role: string): { primary: string; fallback?: string } {
    // 1. data-testid / data-cy / data-test (most stable)
    for (const attr of ["data-testid", "data-cy", "data-test"]) {
      const v = el.getAttribute(attr);
      if (v) return { primary: `[${attr}=${JSON.stringify(v)}]` };
    }
    // 2. aria-label exact
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) {
      const tag = el.tagName.toLowerCase();
      const interactive = ["a", "button", "input", "textarea", "select"].includes(tag);
      // Prefer the tag when it's interactive; fall back to attribute-only.
      const primary = interactive
        ? `${tag}[aria-label=${JSON.stringify(aria)}]`
        : `[aria-label=${JSON.stringify(aria)}]`;
      // Fallback: contains-match if exact misses (e.g., trailing whitespace)
      const trimmedKey = aria.trim().slice(0, 40);
      const fallback = trimmedKey
        ? `[aria-label*=${JSON.stringify(trimmedKey)}]`
        : undefined;
      return { primary, fallback };
    }
    // 3. role + accessible name (aria-label*=) — covers the common case
    if (name) {
      const namePart = name.slice(0, 40);
      return {
        primary: `[role=${JSON.stringify(role)}][aria-label*=${JSON.stringify(namePart)}]`,
        fallback: `${el.tagName.toLowerCase()}:has-text(${JSON.stringify(namePart)})`,
      };
    }
    // 4. id
    if (el.id) {
      return { primary: `#${CSS.escape(el.id)}` };
    }
    // 5. nth-of-type fallback
    return { primary: nthSelector(el) };
  }

  function detectConsentBanner(): boolean {
    const bodyText = (document.body?.textContent || "").toLowerCase().slice(0, 4000);
    const phrases = ["accept all", "reject all", "we use cookies", "consent to", "cookie policy"];
    return phrases.some((p) => bodyText.includes(p));
  }

  const elements: Array<{
    id: number;
    role: string;
    name: string;
    selector: string;
    fallback_selector?: string;
    bbox: { x: number; y: number; w: number; h: number };
    in_viewport: boolean;
    placeholder?: string;
    value?: string;
  }> = [];

  let id = 0;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r)) continue;
    const name = visibleName(el);
    const role = roleOf(el);
    const ranked = rankSelector(el, name, role);
    const inViewport = r.x >= -10 && r.y >= -10 && r.x + r.width <= VW + 10 && r.y + r.height <= VH + 10;
    const entry: (typeof elements)[number] = {
      id: id++,
      role,
      name,
      selector: ranked.primary,
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      in_viewport: inViewport,
    };
    if (ranked.fallback) entry.fallback_selector = ranked.fallback;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const ph = el.placeholder;
      if (ph) entry.placeholder = ph;
      const v = el.value;
      if (v) entry.value = v;
    }
    elements.push(entry);
  }

  // Notes — UI patterns the agent should be aware of.
  const notes: string[] = [];
  const comboboxes = elements.filter((e) => e.role === "combobox");
  for (const c of comboboxes) {
    notes.push(
      `combobox at id ${c.id} ('${c.name || c.placeholder || "(unnamed)"}') — options likely appear only after click + type; use preview_after to see them.`,
    );
  }
  if (detectConsentBanner()) {
    notes.push(
      "consent banner detected — Accept-All button may need to be clicked before the demo, or use a viewport/locale that skips the gate.",
    );
  }

  return {
    page_title: document.title,
    has_consent_banner: detectConsentBanner(),
    viewport: { width: VW, height: VH },
    elements,
    notes,
  };
}

async function runPriorActions(page: Page, actions: PlanStep[]): Promise<void> {
  // Minimal action executor for prior_actions in previewAfter. Mirrors
  // the recorder's behavior at a high level but without snapshot/event
  // capture overhead — we just want to put the page in the right state.
  for (const step of actions) {
    switch (step.action) {
      case "navigate": {
        const url = step.selector ?? "";
        await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(800);
        break;
      }
      case "click": {
        if (step.selector) {
          await page.click(step.selector, { timeout: 5000 }).catch(() => {});
        }
        await page.waitForTimeout(step.expected_duration_ms ?? 600);
        break;
      }
      case "type": {
        if (step.selector) {
          await page.click(step.selector, { timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(300);
          await page.keyboard.type(step.value ?? "", { delay: 30 });
        }
        await page.waitForTimeout(800);
        break;
      }
      case "scroll": {
        const sel = step.selector ?? "body";
        await page.evaluate((s) => {
          const el = document.querySelector(s) as HTMLElement | null;
          const target = el ?? document.scrollingElement ?? document.body;
          target.scrollBy({ top: 300, behavior: "smooth" });
        }, sel);
        await page.waitForTimeout(step.expected_duration_ms ?? 800);
        break;
      }
      case "hover": {
        if (step.selector) {
          await page.hover(step.selector, { timeout: 5000 }).catch(() => {});
        }
        await page.waitForTimeout(step.expected_duration_ms ?? 600);
        break;
      }
      case "wait": {
        await page.waitForTimeout(step.expected_duration_ms ?? 500);
        break;
      }
      case "wait_for_selector": {
        if (step.selector) {
          await page.waitForSelector(step.selector, { timeout: 10_000 }).catch(() => {});
        }
        break;
      }
      default:
        // unknown action — skip silently to avoid breaking the snapshot
        break;
    }
  }
}

async function snapshotInternal(opts: PreviewOptions, prior_actions: PlanStep[]): Promise<PreviewResult> {
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const settleMs = opts.settle_ms ?? 1500;
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.goto(opts.url, { waitUntil: "networkidle", timeout: 25_000 }).catch(() => {});
    await page.waitForTimeout(settleMs);
    if (prior_actions.length > 0) {
      await runPriorActions(page, prior_actions);
    }
    const snap = (await page.evaluate(pageSideSnapshot)) as Awaited<
      ReturnType<typeof pageSideSnapshot>
    >;
    const url_after_load = page.url();
    return {
      url_after_load,
      viewport: snap.viewport,
      page_title: snap.page_title,
      has_consent_banner: snap.has_consent_banner,
      elements: snap.elements,
      notes: snap.notes,
    };
  } finally {
    await browser.close();
  }
}

/** Snapshot a URL's interactive elements — no actions run before. */
export async function preview(opts: PreviewOptions): Promise<PreviewResult> {
  return snapshotInternal(opts, []);
}

/** Snapshot AFTER running prior_actions — exposes popup / modal / post-nav state. */
export async function previewAfter(opts: PreviewAfterOptions): Promise<PreviewResult> {
  return snapshotInternal(opts, opts.prior_actions ?? []);
}
