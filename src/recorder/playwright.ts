/**
 * Playwright-driven recorder. Captures:
 *   - Frame sequence as PNG via CDP Page.startScreencast (v1)
 *   - Structured event log (clicks, inputs, navigations, hovers)
 *   - Continuous cursor samples for spring-resolution at compose time
 *
 * v1 uses startScreencast (good enough; ~30-60fps achievable on modern hardware).
 * v1.5 will swap to HeadlessExperimental.beginFrame for true frame-perfect 60fps
 * (the Hyperframes pattern: see /Users/shhdwi/Motion/hyperframes/packages/producer).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright-core";
import type { CaptureProfile } from "../core/types.js";
import type { DemoPlan, PlanStep } from "../plan/types.js";
import { ensureDir, recordingDir, type ProjectPaths } from "../utils/paths.js";
import type { CursorSample, RecordedEvent, RecordingManifest } from "./events.js";

export interface RecordOptions {
  plan: DemoPlan;
  capture: CaptureProfile;
  paths: ProjectPaths;
  /** Override the recording id (default: plan.id + timestamp) */
  recording_id?: string;
}

export interface RecordResult {
  recording_id: string;
  recording_dir: string;
  manifest: RecordingManifest;
}

const CURSOR_POLL_MS = 16; // ~60Hz cursor sampling

export async function recordPlaywright(opts: RecordOptions): Promise<RecordResult> {
  const id = opts.recording_id ?? `${opts.plan.id}-${Date.now()}`;
  const dir = recordingDir(opts.paths, id);
  const framesDir = path.join(dir, "frames");
  await ensureDir(framesDir);

  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({
    viewport: opts.capture.viewport,
    deviceScaleFactor: opts.capture.device_pixel_ratio,
  });
  const page: Page = await context.newPage();

  const events: RecordedEvent[] = [];
  const cursorSamples: CursorSample[] = [];
  const startTime = Date.now();
  const tNow = (): number => Date.now() - startTime;

  // ── Wire event listeners ────────────────────────────────────────────────
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      events.push({ kind: "navigation", t_ms: tNow(), target: frame.url() });
    }
  });

  // Inject script to forward DOM events back via console binding.
  await page.exposeBinding("__openslate_emit", (_src, payload: RecordedEvent) => {
    events.push({ ...payload, t_ms: tNow() });
  });

  await page.addInitScript(() => {
    const w = window as unknown as { __openslate_emit?: (e: unknown) => void };
    if (!w.__openslate_emit) return;
    document.addEventListener(
      "click",
      (e) => {
        const target = e.target as HTMLElement | null;
        w.__openslate_emit?.({
          kind: "click",
          t_ms: 0,
          x: e.clientX,
          y: e.clientY,
          target: target ? cssPath(target) : undefined,
        });
      },
      { capture: true },
    );
    document.addEventListener(
      "scroll",
      () => {
        w.__openslate_emit?.({
          kind: "scroll",
          t_ms: 0,
          x: window.scrollX,
          y: window.scrollY,
        });
      },
      { capture: true, passive: true },
    );

    function cssPath(el: HTMLElement): string {
      const parts: string[] = [];
      let cur: HTMLElement | null = el;
      while (cur && cur !== document.body && parts.length < 6) {
        const tag = cur.tagName.toLowerCase();
        const id = cur.id ? `#${cur.id}` : "";
        const cls = cur.className && typeof cur.className === "string"
          ? `.${cur.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
        parts.unshift(`${tag}${id}${cls}`);
        cur = cur.parentElement;
      }
      return parts.join(" > ");
    }
  });

  // ── Start CDP screencast ────────────────────────────────────────────────
  // v1 simple capture; v1.5 should switch to HeadlessExperimental.beginFrame.
  const client = await context.newCDPSession(page);
  let frameIndex = 0;
  await client.send("Page.startScreencast", {
    format: "png",
    quality: 90,
    everyNthFrame: 1,
  });
  client.on("Page.screencastFrame", async (event) => {
    const buffer = Buffer.from(event.data, "base64");
    const fname = path.join(framesDir, `frame_${String(frameIndex).padStart(6, "0")}.png`);
    await fs.writeFile(fname, buffer);
    frameIndex++;
    await client.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });

  // Cursor tracker. Playwright doesn't expose a native cursor stream so we
  // poll the mouse position by overlaying a global mousemove listener.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __openslate_cursor?: { x: number; y: number };
    };
    w.__openslate_cursor = { x: 0, y: 0 };
    document.addEventListener("mousemove", (e) => {
      w.__openslate_cursor = { x: e.clientX, y: e.clientY };
    });
  });
  let cursorPollTimer: NodeJS.Timeout | null = null;
  const pollCursor = async () => {
    try {
      const pos = await page.evaluate(() => {
        const w = window as unknown as { __openslate_cursor?: { x: number; y: number } };
        return w.__openslate_cursor ?? { x: 0, y: 0 };
      });
      cursorSamples.push({ t_ms: tNow(), x: pos.x, y: pos.y });
    } catch {
      // page closed; stop
      if (cursorPollTimer) clearInterval(cursorPollTimer);
    }
  };
  cursorPollTimer = setInterval(pollCursor, CURSOR_POLL_MS);

  // ── Execute plan ────────────────────────────────────────────────────────
  events.push({ kind: "frame_start", t_ms: tNow() });

  for (const [stepIndex, step] of opts.plan.steps.entries()) {
    await executeStep(page, step, stepIndex);
  }

  events.push({ kind: "frame_end", t_ms: tNow() });
  const totalDurationMs = tNow();

  // ── Tear down ───────────────────────────────────────────────────────────
  if (cursorPollTimer) clearInterval(cursorPollTimer);
  await client.send("Page.stopScreencast").catch(() => {});
  await browser.close();

  // ── Persist artifacts ───────────────────────────────────────────────────
  const eventsFile = path.join(dir, "events.json");
  const cursorFile = path.join(dir, "cursor.json");
  const planFile = path.join(dir, "plan.json");

  await Promise.all([
    fs.writeFile(eventsFile, JSON.stringify(events, null, 2)),
    fs.writeFile(cursorFile, JSON.stringify(cursorSamples, null, 2)),
    fs.writeFile(planFile, JSON.stringify(opts.plan, null, 2)),
  ]);

  const manifest: RecordingManifest = {
    id,
    created_at: new Date().toISOString(),
    duration_ms: totalDurationMs,
    fps: opts.capture.fps,
    viewport: opts.capture.viewport,
    device_pixel_ratio: opts.capture.device_pixel_ratio,
    frame_count: frameIndex,
    frames_dir: "frames",
    events_file: "events.json",
    cursor_file: "cursor.json",
    plan_file: "plan.json",
    base_url: opts.plan.base_url,
  };
  const manifestFile = path.join(dir, "manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));

  return { recording_id: id, recording_dir: dir, manifest };
}

async function executeStep(page: Page, step: PlanStep, stepIndex: number): Promise<void> {
  // Honor a small pre-step pause so cursor samples settle (principle 4: anticipation).
  const safeWait = (ms: number) => page.waitForTimeout(Math.max(0, ms));

  switch (step.action) {
    case "navigate": {
      const url = step.selector ?? "";
      await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 }).catch(() => {});
      await safeWait(step.expected_duration_ms);
      break;
    }
    case "click": {
      if (!step.selector) {
        await safeWait(step.expected_duration_ms);
        break;
      }
      try {
        // Move slowly so the cursor poll captures intermediate positions.
        const handle = await page.$(step.selector);
        if (handle) {
          const box = await handle.boundingBox();
          if (box) {
            const target_x = box.x + box.width / 2;
            const target_y = box.y + box.height / 2;
            // principle 4: anticipation — slow approach so cursor reads as decided.
            await page.mouse.move(target_x, target_y, { steps: 24 });
            // hold before clicking; recorder layer also adds artificial settle.
            await safeWait(200);
            await page.mouse.click(target_x, target_y);
          } else {
            await page.click(step.selector, { timeout: 5000 });
          }
        } else {
          await page.click(step.selector, { timeout: 5000 });
        }
      } catch {
        // selector not found; record but don't abort
      }
      // remaining hold is the "post-action read" budget (principle 1)
      await safeWait(Math.max(0, step.expected_duration_ms - 200 - 50));
      break;
    }
    case "type": {
      if (step.selector) {
        await page.fill(step.selector, "").catch(() => {});
        await page.type(step.selector, step.value ?? "", { delay: 30 });
      }
      await safeWait(Math.max(0, step.expected_duration_ms - (step.value ?? "").length * 30));
      break;
    }
    case "scroll": {
      const sel = step.selector ?? "body";
      await page.evaluate((s) => {
        const el = document.querySelector(s) as HTMLElement | null;
        const target = el ?? document.scrollingElement ?? document.body;
        target.scrollBy({ top: 300, behavior: "smooth" });
      }, sel);
      await safeWait(step.expected_duration_ms);
      break;
    }
    case "hover": {
      if (step.selector) {
        await page.hover(step.selector, { timeout: 5000 }).catch(() => {});
      }
      await safeWait(step.expected_duration_ms);
      break;
    }
    case "wait_for_selector": {
      if (step.selector) {
        await page.waitForSelector(step.selector, { timeout: 10_000 }).catch(() => {});
      }
      break;
    }
    case "wait":
    default:
      await safeWait(step.expected_duration_ms);
  }
  // suppress unused-arg warning while keeping interface stable
  void stepIndex;
}
