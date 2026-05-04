/**
 * Playwright-driven recorder. Captures:
 *   - Frame sequence as PNG via CDP Page.startScreencast (v1)
 *   - Structured event log (clicks, inputs, navigations, hovers)
 *   - Continuous cursor samples via a page-side mousemove listener that
 *     emits through Playwright's exposeBinding (no polling, sub-frame accurate)
 *
 * Cursor sampling design (changed from setInterval polling):
 *   - Page-side mousemove listener throttles to ~8ms (≈125Hz max)
 *   - Each sample emits through __openslate_emit with kind "cursor_move"
 *   - Node-side handler routes cursor_move → cursorSamples (vs. events)
 *   - Click events also push a synthetic cursor sample at the click position,
 *     so the cursor's resolved trajectory always passes through every click
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

/** Page-side mousemove throttle. ~8ms = ~125Hz max sample rate. */
const CURSOR_THROTTLE_MS = 8;

/**
 * Minimum settle time after a page navigates and reaches networkidle, before
 * the recorder advances to the next plan step. Hosted sites often finish
 * networkidle while hero fonts/animations are still resolving, so the demo
 * starts mid-render. 1500ms is the calibrated minimum where the demo always
 * starts on a fully-painted page.
 */
const POST_NAV_SETTLE_MS = 1500;

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

  // ── Routing handler: cursor_move → cursorSamples; everything else → events.
  // Click events also push a synthetic cursor sample at the click position so
  // the resolved spring trajectory always passes through the click point.
  type EmittedPayload = {
    kind: string;
    t_ms?: number;
    x?: number;
    y?: number;
    target?: string;
    value?: string;
  };
  await page.exposeBinding("__openslate_emit", (_src, payload: EmittedPayload) => {
    const t = tNow();
    if (payload.kind === "cursor_move") {
      cursorSamples.push({ t_ms: t, x: payload.x ?? 0, y: payload.y ?? 0 });
      return;
    }
    if (payload.kind === "click") {
      cursorSamples.push({ t_ms: t, x: payload.x ?? 0, y: payload.y ?? 0 });
    }
    events.push({ ...(payload as RecordedEvent), t_ms: t });
  });

  // ── Page-side listeners: mousemove (throttled) + click + scroll.
  await page.addInitScript(
    ({ throttleMs }) => {
      const w = window as unknown as {
        __openslate_emit?: (e: unknown) => void;
        __openslate_lastMove?: number;
      };
      if (!w.__openslate_emit) return;
      w.__openslate_lastMove = 0;

      // Cursor stream — direct binding, throttled on the page side.
      document.addEventListener(
        "mousemove",
        (e) => {
          const now = performance.now();
          const last = w.__openslate_lastMove ?? 0;
          if (now - last < throttleMs) return;
          w.__openslate_lastMove = now;
          w.__openslate_emit?.({
            kind: "cursor_move",
            x: e.clientX,
            y: e.clientY,
          });
        },
        { capture: true, passive: true },
      );

      // Click — semantic event + drives auto-zoom + click-bounce timing.
      document.addEventListener(
        "click",
        (e) => {
          const target = e.target as HTMLElement | null;
          w.__openslate_emit?.({
            kind: "click",
            x: e.clientX,
            y: e.clientY,
            target: target ? cssPath(target) : undefined,
          });
        },
        { capture: true },
      );

      // Scroll — semantic event for caption / pacing context.
      document.addEventListener(
        "scroll",
        () => {
          w.__openslate_emit?.({
            kind: "scroll",
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
          const cls =
            cur.className && typeof cur.className === "string"
              ? `.${cur.className.trim().split(/\s+/).slice(0, 2).join(".")}`
              : "";
          parts.unshift(`${tag}${id}${cls}`);
          cur = cur.parentElement;
        }
        return parts.join(" > ");
      }
    },
    { throttleMs: CURSOR_THROTTLE_MS },
  );

  // Seed the cursor trajectory off-screen at t=0 so the cursor is invisible
  // during the page-load period before any real mousemove fires. When the
  // first action's mouse.move kicks in, the spring animates from off-screen
  // into the scene — feels like the cursor "enters" the frame intentionally.
  cursorSamples.push({
    t_ms: 0,
    x: -200,
    y: -200,
  });

  // Apply browser zoom (capture.browser_zoom) on every page load via an
  // init script. Equivalent to the user pressing Cmd-+ in a real browser.
  // Re-applies after any client-side route change so SPAs stay zoomed.
  if (opts.capture.browser_zoom && opts.capture.browser_zoom !== 1) {
    await page.addInitScript((z) => {
      const apply = () => {
        document.documentElement.style.zoom = String(z);
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", apply);
      } else {
        apply();
      }
    }, opts.capture.browser_zoom);
  }

  // ── Start CDP screencast ────────────────────────────────────────────────
  // v1 simple capture; v1.5 should switch to HeadlessExperimental.beginFrame.
  // Race fix: capture frameIndex atomically with post-increment BEFORE the
  // async writeFile yields. Otherwise two handlers can read the same index
  // and overwrite each other's output, producing gaps in the sequence.
  const client = await context.newCDPSession(page);
  let frameIndex = 0;
  /** Per-frame recording timestamps. Captured at handler invocation so the
   *  composition can map output time → exact source frame even though CDP
   *  screencast is delta-emitted (sparse over static pages). */
  const frameTimestamps: { idx: number; t_ms: number }[] = [];
  await client.send("Page.startScreencast", {
    format: "png",
    quality: 90,
    everyNthFrame: 1,
  });
  client.on("Page.screencastFrame", async (event) => {
    const myIndex = frameIndex++; // atomic in single-threaded JS event loop
    const myTime = tNow();
    frameTimestamps.push({ idx: myIndex, t_ms: myTime });
    const buffer = Buffer.from(event.data, "base64");
    const fname = path.join(framesDir, `frame_${String(myIndex).padStart(6, "0")}.png`);
    try {
      await fs.writeFile(fname, buffer);
    } catch (err) {
      console.error(`[recorder] failed to write frame ${myIndex}:`, err);
    }
    await client.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });

  // ── Execute plan ────────────────────────────────────────────────────────
  events.push({ kind: "frame_start", t_ms: tNow() });

  /**
   * Step-boundary snapshot. CDP screencast is delta-emitted: static pages
   * (no animation, no input) emit no frames. Without explicit snapshots,
   * the compositor's source-frame mapping at output time may have no
   * frame to show during pre-action or post-action stillness. We snap a
   * fresh PNG at each step boundary so there's always a frame available.
   *
   * Snapshots use the same numbering scheme as screencast frames, and
   * their timestamps are inserted into frameTimestamps for the compositor's
   * binary search to find them.
   */
  const snapshotFrame = async () => {
    try {
      const buf = await page.screenshot({ type: "png" });
      const myIndex = frameIndex++;
      const myTime = tNow();
      frameTimestamps.push({ idx: myIndex, t_ms: myTime });
      const fname = path.join(framesDir, `frame_${String(myIndex).padStart(6, "0")}.png`);
      await fs.writeFile(fname, buf);
    } catch (err) {
      console.error("[recorder] step-boundary snapshot failed:", err);
    }
  };

  for (const [stepIndex, step] of opts.plan.steps.entries()) {
    await snapshotFrame(); // capture pre-step state
    await executeStep(page, step, stepIndex, events, tNow);
  }
  await snapshotFrame(); // capture final state after last step

  events.push({ kind: "frame_end", t_ms: tNow() });
  const totalDurationMs = tNow();

  // Post-pass: attach step metadata (note, no_zoom, is_protagonist, step_index)
  // to click events emitted by the DOM listener. We can't tag those at emit
  // time because they come from a binding — we tag them now by step.action
  // ordering. This makes captions in `from_steps` mode work.
  attachStepMetadataToClicks(events, opts.plan.steps);

  // ── Tear down ───────────────────────────────────────────────────────────
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

  // Scan the frames dir to record exactly which indices made it to disk,
  // then look up each one's capture timestamp.
  const frameFiles = await fs.readdir(framesDir);
  const frame_indices = frameFiles
    .filter((f) => /^frame_\d+\.png$/.test(f))
    .map((f) => Number.parseInt(f.replace(/[^\d]/g, ""), 10))
    .sort((a, b) => a - b);
  const tsByIdx = new Map<number, number>();
  for (const ts of frameTimestamps) tsByIdx.set(ts.idx, ts.t_ms);
  const frame_timestamps_ms = frame_indices.map((idx) => tsByIdx.get(idx) ?? 0);

  // Compute the start offset: trim the page-load / settle period so the
  // visible portion of the output starts ~800ms before the first
  // PLAN-DRIVEN interactive event. We only count events that originated
  // from a plan step (step_index defined) — natural page-emitted events
  // like scroll-on-load or initial focus shouldn't trip the trim, since
  // those happen DURING page load which is what we want to skip.
  const LEAD_IN_MS = 800;
  const interactiveKinds = new Set(["click", "type", "scroll", "hover"]);
  const firstInteractive = events.find(
    (e) => interactiveKinds.has(e.kind) && typeof e.step_index === "number",
  );
  const start_offset_ms = firstInteractive
    ? Math.max(0, firstInteractive.t_ms - LEAD_IN_MS)
    : 0;

  const manifest: RecordingManifest = {
    id,
    created_at: new Date().toISOString(),
    duration_ms: totalDurationMs,
    fps: opts.capture.fps,
    viewport: opts.capture.viewport,
    device_pixel_ratio: opts.capture.device_pixel_ratio,
    frame_count: frame_indices.length,
    frame_indices,
    frame_timestamps_ms,
    start_offset_ms,
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

/**
 * Walk through plan steps and the events log together, attaching step
 * metadata to each click event in order. Plan click steps map 1:1 to
 * emitted click events under normal flow (selector found, no retry). When
 * counts diverge (selector miss, sub-event), we degrade gracefully.
 */
function attachStepMetadataToClicks(events: RecordedEvent[], steps: PlanStep[]): void {
  const clickSteps = steps
    .map((s, i) => ({ step: s, index: i }))
    .filter(({ step }) => step.action === "click");
  let nextStep = 0;
  for (const ev of events) {
    if (ev.kind !== "click") continue;
    if (ev.synthetic) continue; // already tagged at emit
    const target = clickSteps[nextStep];
    if (!target) break;
    ev.step_index = target.index;
    ev.note = target.step.note;
    ev.no_zoom = target.step.no_zoom;
    nextStep++;
  }
}

async function executeStep(
  page: Page,
  step: PlanStep,
  stepIndex: number,
  events: RecordedEvent[],
  tNow: () => number,
): Promise<void> {
  const safeWait = (ms: number) => page.waitForTimeout(Math.max(0, ms));

  /**
   * Helper: resolve a selector to its on-screen viewport-space center. Used
   * to synthesize zoom-eligible events for type/scroll/hover steps where
   * the DOM-listener path doesn't naturally emit a click.
   */
  async function resolveCenter(
    selector: string | undefined,
  ): Promise<{ x: number; y: number } | null> {
    if (!selector) return null;
    try {
      const handle = await page.$(selector);
      if (!handle) return null;
      const box = await handle.boundingBox();
      if (!box) return null;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    } catch {
      return null;
    }
  }

  /** Emit a synthetic interaction event so the auto-zoom resolver can pick it up. */
  function emitInteraction(
    kind: "click" | "type" | "scroll" | "hover",
    x: number,
    y: number,
  ) {
    events.push({
      kind,
      t_ms: tNow(),
      x,
      y,
      step_index: stepIndex,
      note: step.note,
      no_zoom: step.no_zoom,
      synthetic: true,
    });
  }

  switch (step.action) {
    case "navigate": {
      const url = step.selector ?? "";
      await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 }).catch(() => {});
      // Mandatory post-load settle so demos always start on a fully-painted
      // page, never mid-hero-animation.
      await safeWait(POST_NAV_SETTLE_MS);
      await safeWait(step.expected_duration_ms);
      break;
    }
    case "click": {
      if (!step.selector) {
        await safeWait(step.expected_duration_ms);
        break;
      }
      const center = await resolveCenter(step.selector);
      try {
        if (center) {
          // principle 4: anticipation — slow approach so cursor reads as decided.
          await page.mouse.move(center.x, center.y, { steps: 24 });
          await safeWait(200);
          await page.mouse.click(center.x, center.y);
        } else {
          await page.click(step.selector, { timeout: 5000 });
        }
      } catch {
        // selector not found; record but don't abort
      }
      // The DOM "click" listener will already emit a click event with x/y,
      // and we attach step metadata to whichever click event lands closest
      // (post-pass below). Remaining hold is the "post-action read" budget.
      await safeWait(Math.max(0, step.expected_duration_ms - 200 - 50));
      break;
    }
    case "type": {
      // Move the mouse to the target field so the cursor visually lands
      // there, emit a synthetic "type" event for auto-zoom, then focus +
      // type. We use page.focus (not page.click) to avoid emitting a
      // DOM-listener click that would confuse the click→step mapping.
      if (step.selector) {
        const center = await resolveCenter(step.selector);
        if (center) {
          await page.mouse.move(center.x, center.y, { steps: 18 });
          emitInteraction("type", center.x, center.y);
        }
        await page.focus(step.selector).catch(() => {});
        await page.fill(step.selector, "").catch(() => {});
        await page.type(step.selector, step.value ?? "", { delay: 30 });
      }
      await safeWait(Math.max(0, step.expected_duration_ms - (step.value ?? "").length * 30));
      break;
    }
    case "scroll": {
      const sel = step.selector ?? "body";
      const center = await resolveCenter(sel);
      if (center) emitInteraction("scroll", center.x, center.y);
      await page.evaluate((s) => {
        const el = document.querySelector(s) as HTMLElement | null;
        const target = el ?? document.scrollingElement ?? document.body;
        target.scrollBy({ top: 300, behavior: "smooth" });
      }, sel);
      await safeWait(step.expected_duration_ms);
      break;
    }
    case "hover": {
      const center = await resolveCenter(step.selector);
      if (center) {
        await page.mouse.move(center.x, center.y, { steps: 18 });
        emitInteraction("hover", center.x, center.y);
      } else if (step.selector) {
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
  void stepIndex;
}
