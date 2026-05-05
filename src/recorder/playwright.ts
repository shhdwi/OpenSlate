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
import type { CursorKind, CursorSample, RecordedEvent, RecordingManifest } from "./events.js";
import { installStabilityObservers, waitForVisualStability } from "./stability.js";

/**
 * Map a CSS `cursor` keyword to the sprite kind we ship. We collapse the
 * full CSS cursor vocabulary into 5 kinds because anything finer (zoom-in,
 * crosshair, col-resize, ...) hits diminishing returns for product demos.
 *
 * - pointer / hand → "pointer" (links, buttons)
 * - text / vertical-text → "text" (text fields, contenteditable)
 * - grab / grabbing / move / all-scroll → "grab" (drag handles, draggable)
 * - not-allowed / no-drop → "not-allowed" (disabled state)
 * - everything else → "arrow"
 *
 * `cursor: url(...)` (custom cursors) collapses to "arrow" — Recordly's
 * sprite set is what we render, not the page's custom URL.
 */
export function mapCssCursor(css: string | undefined): CursorKind {
  if (!css) return "arrow";
  // Strip url(...) prefix, take the first non-url keyword.
  // e.g. "url(/foo.svg) 5 5, pointer" → "pointer"
  const cleaned = css
    .split(",")
    .map((s) => s.trim())
    .filter((s) => !s.startsWith("url("))
    .join(",");
  const keyword = cleaned.split(",")[0]?.trim().toLowerCase() ?? "";
  switch (keyword) {
    case "pointer":
    case "hand":
      return "pointer";
    case "text":
    case "vertical-text":
    case "ibeam":
      return "text";
    case "grab":
    case "grabbing":
    case "move":
    case "all-scroll":
      return "grab";
    case "not-allowed":
    case "no-drop":
      return "not-allowed";
    default:
      return "arrow";
  }
}

export interface RecordOptions {
  plan: DemoPlan;
  capture: CaptureProfile;
  paths: ProjectPaths;
  /** Override the recording id (default: plan.id + timestamp) */
  recording_id?: string;
  /**
   * Hold (ms) after the last plan step before the recorder stops so the
   * final-page state (e.g. flight detail, signup confirmation, results
   * load) is captured. Mirrors profile.playback.final_hold_ms — passed
   * through by the orchestrator.
   */
  final_hold_ms?: number;
}

export interface StepResult {
  step_index: number;
  action: string;
  /**
   * - "fired": the action ran (selector resolved or selector not needed)
   * - "selector_missed": the selector didn't match any element; recorder
   *   skipped the action without aborting the recording
   * - "skipped": no-op step (e.g. wait without selector)
   */
  status: "fired" | "selector_missed" | "skipped";
  selector?: string;
  resolved_at?: { x: number; y: number } | null;
}

export interface RecordResult {
  recording_id: string;
  recording_dir: string;
  manifest: RecordingManifest;
  /**
   * Per-step outcome. Surfaces "selector_missed" so the calling agent
   * can retry with a fresh preview snapshot or surface the failure to
   * the user instead of producing a partial demo silently.
   */
  step_results: StepResult[];
}

/** Page-side mousemove throttle. ~8ms = ~125Hz max sample rate. */
const CURSOR_THROTTLE_MS = 8;

/**
 * Pre-click dwell on the source page. After the cursor reaches the target
 * but BEFORE the real `mouse.click()` fires, we emit a synthetic click
 * event and hold the page steady for this duration. The renderer's click
 * bounce + halo are anchored to the synthetic click's timestamp, so the
 * animation plays out against frames captured on the SOURCE page.
 *
 * Calibrated to cover bounce (260ms) + halo (700ms) + small cushion. The
 * previous value (1300ms) was an upper bound that included a budget for
 * "the page is about to navigate, hold the source page until the halo is
 * COMPLETELY transparent." That trailing budget showed up as visible
 * click-lag on non-navigating clicks (cursor visibly clicks → page sits
 * frozen → page finally responds). Now: hold long enough for the halo to
 * be ≥90% faded (alpha < 0.1 — invisible to the eye even if the new page
 * paints over the last frame); stability detection takes over after the
 * real click and waits ONLY as long as the page actually needs.
 */
const PRE_CLICK_DWELL_MS = 750;

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

  // Inject DOM-mutation + layout-shift observers BEFORE any goto so the
  // observers exist on every page (init scripts re-run on each navigation).
  // waitForVisualStability() reads `window.__openslate_stability_snapshot()`
  // and replaces hardcoded post-action waits with "wait until the page has
  // visually settled." Falls back to its `timeout_ms` ceiling if the page
  // never settles (e.g., always-running animations).
  await installStabilityObservers(page);

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
    /** CSS cursor at the sample point (e.g. "pointer", "text", "default") */
    css_cursor?: string;
  };
  await page.exposeBinding("__openslate_emit", (_src, payload: EmittedPayload) => {
    const t = tNow();
    if (payload.kind === "cursor_move") {
      cursorSamples.push({
        t_ms: t,
        x: payload.x ?? 0,
        y: payload.y ?? 0,
        kind: mapCssCursor(payload.css_cursor),
      });
      return;
    }
    if (payload.kind === "click") {
      cursorSamples.push({
        t_ms: t,
        x: payload.x ?? 0,
        y: payload.y ?? 0,
        kind: mapCssCursor(payload.css_cursor),
      });
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

      // Read the *effective* CSS cursor at (x,y) — i.e., what the browser
      // would have drawn natively. elementFromPoint resolves the topmost
      // element under the point; getComputedStyle.cursor gives us
      // "pointer", "text", "grab", "not-allowed", "default", etc.
      // Lightweight (~0.1ms per call) and runs at the throttled cadence,
      // so the page-perf overhead is negligible.
      function readCursorAt(x: number, y: number): string {
        try {
          const el = document.elementFromPoint(x, y);
          if (!el) return "default";
          return getComputedStyle(el).cursor || "default";
        } catch {
          return "default";
        }
      }

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
            css_cursor: readCursorAt(e.clientX, e.clientY),
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
            css_cursor: readCursorAt(e.clientX, e.clientY),
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
    kind: "arrow",
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

  const step_results: StepResult[] = [];
  for (const [stepIndex, step] of opts.plan.steps.entries()) {
    await snapshotFrame(); // capture pre-step state
    const result = await executeStep(page, step, stepIndex, events, cursorSamples, tNow);
    step_results.push(result);
  }
  // Final-page hold: keep the recorder running so the post-last-action
  // page state (typically a navigation target) is captured. Without this
  // the recorder cuts off ~1.5s after the last click, often before the
  // destination page finishes painting.
  const finalHoldMs = opts.final_hold_ms ?? 3000;
  if (finalHoldMs > 0) {
    // Snapshot at intervals during the hold so any visual change that
    // happens during page-load (network responses, animations resolving)
    // gets captured. CDP is delta-emitted; explicit snapshots fill gaps.
    const interval = 1000;
    let waited = 0;
    while (waited < finalHoldMs) {
      const dt = Math.min(interval, finalHoldMs - waited);
      await page.waitForTimeout(dt);
      await snapshotFrame();
      waited += dt;
    }
  }
  await snapshotFrame(); // capture final state after last step

  events.push({ kind: "frame_end", t_ms: tNow() });
  const totalDurationMs = tNow();

  // Post-pass 1: dedupe DOM-emitted clicks that follow synthetic clicks.
  // The plan-driven click flow emits a synthetic click BEFORE the real
  // mouse.click() so the renderer's animations play out on source-page
  // frames; the real click then ALSO triggers the DOM listener, producing
  // a near-duplicate. Drop those to avoid double-bounce / double-halo.
  dropDuplicateDomClicks(events);

  // Post-pass 2: attach step metadata (note, no_zoom, is_protagonist,
  // step_index) to click events that arrived without it. With the
  // synthetic-first flow, plan-driven clicks are already tagged at emit
  // time; this only catches the rare case of a missed synthetic.
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

  return { recording_id: id, recording_dir: dir, manifest, step_results };
}

/**
 * Remove DOM-listener-emitted click events that are near-duplicates of
 * a preceding synthetic CLICK or TYPE event. The recorder fires
 * mouse.click() to anchor each click step (and to focus the field
 * before typing); each fires the page-side click listener, producing
 * a duplicate non-synthetic click. We dedupe by proximity:
 *   - 100px in either axis
 *   - 2500ms after the synthetic
 *   - synthetic kind is "click" (real click steps) or "type" (the
 *     focusing click that precedes typing)
 *
 * Without this, the spare DOM click leaks into events.json, gets
 * mis-attached to the next click step's metadata, and produces a
 * second zoom envelope.
 *
 * Exported for unit testing.
 */
export function dropDuplicateDomClicks(events: RecordedEvent[]): void {
  const PROX_PX = 100;
  const WINDOW_MS = 2500;
  const toDrop = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const a = events[i];
    if (!a || !a.synthetic) continue;
    if (a.kind !== "click" && a.kind !== "type") continue;
    for (let j = i + 1; j < events.length; j++) {
      const b = events[j];
      if (!b || b.kind !== "click") continue;
      if (b.synthetic) continue;
      if (b.t_ms - a.t_ms > WINDOW_MS) break;
      if (Math.abs((b.x ?? 0) - (a.x ?? 0)) > PROX_PX) continue;
      if (Math.abs((b.y ?? 0) - (a.y ?? 0)) > PROX_PX) continue;
      toDrop.add(j);
    }
  }
  if (toDrop.size === 0) return;
  // Splice from the end so indices stay valid.
  for (const idx of [...toDrop].sort((a, b) => b - a)) {
    events.splice(idx, 1);
  }
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
  cursorSamples: CursorSample[],
  tNow: () => number,
): Promise<StepResult> {
  // Per-step result; we mutate this through the switch then return.
  const result: StepResult = {
    step_index: stepIndex,
    action: step.action,
    status: "skipped",
    selector: step.selector,
  };
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

  /**
   * Wait until the selector's bounding box has been stable across
   * `requiredStable` consecutive 150ms checks. Returns the final stable
   * box, or null if unstable / unresolvable within the timeout.
   *
   * Used by the `highlight` action so the camera's IN-phase animation
   * fires onto a settled element (search results, dashboard widgets,
   * AI-generated outputs that take 1-3s to fully render after the
   * selector first matches). Default tolerance: 1px x/y drift.
   */
  async function waitForStableBbox(
    page: Page,
    selector: string,
    requiredStable = 3,
    pollIntervalMs = 150,
    maxWaitMs = 5000,
    drift_tol_px = 1,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const start = Date.now();
    let prev: { x: number; y: number; width: number; height: number } | null = null;
    let stable = 0;
    while (Date.now() - start < maxWaitMs) {
      let box: { x: number; y: number; width: number; height: number } | null = null;
      try {
        const handle = await page.$(selector);
        if (handle) box = await handle.boundingBox();
      } catch {
        box = null;
      }
      if (!box) {
        // Element disappeared mid-poll — reset stability counter and retry.
        prev = null;
        stable = 0;
      } else if (
        prev &&
        Math.abs(box.x - prev.x) <= drift_tol_px &&
        Math.abs(box.y - prev.y) <= drift_tol_px &&
        Math.abs(box.width - prev.width) <= drift_tol_px &&
        Math.abs(box.height - prev.height) <= drift_tol_px
      ) {
        stable++;
        if (stable >= requiredStable) return box;
      } else {
        stable = 1;
      }
      prev = box;
      await page.waitForTimeout(pollIntervalMs);
    }
    return prev;
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
      result.status = "fired";
      await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 }).catch(() => {});
      // Wait for the page to visually settle (no DOM mutations + no layout
      // shifts for `stable_window_ms`). Replaces the previous hardcoded
      // POST_NAV_SETTLE_MS (1500ms) which was wrong in both directions —
      // hero fonts/animations on slow pages still resolved AFTER 1500ms,
      // and fast pages sat on a frozen frame for 1500ms unnecessarily.
      // Ceiling = POST_NAV_SETTLE_MS + step.expected_duration_ms so the
      // worst-case wait matches the previous behavior.
      await waitForVisualStability(page, {
        timeout_ms: POST_NAV_SETTLE_MS + step.expected_duration_ms,
        stable_window_ms: 500,
        min_wait_ms: 400,
        require_network_idle: true,
      });
      break;
    }
    case "click": {
      if (!step.selector) {
        await safeWait(step.expected_duration_ms);
        break;
      }
      const center = await resolveCenter(step.selector);
      if (!center) {
        result.status = "selector_missed";
        result.resolved_at = null;
        await safeWait(step.expected_duration_ms);
        break;
      }
      result.status = "fired";
      result.resolved_at = center;
      try {
        if (center) {
          // principle 4: anticipation — slow approach so cursor reads as decided.
          await page.mouse.move(center.x, center.y, { steps: 24 });
          // Spring-settle window: the cursor's spring smoothing has lag
          // proportional to the inbound velocity. After mouse.move, give
          // the spring ~500ms (≈3-4 spring time constants at our default
          // stiffness) so it converges onto the target before the click
          // fires. The compositor also snaps the cursor to the click x/y
          // during the click window as a defense-in-depth, but a settled
          // spring keeps the in-flight motion clean too.
          await safeWait(500);
          // Emit a synthetic click ANCHORED to the source-page dwell — the
          // renderer keys click bounce + halo off this timestamp. Holding
          // the cursor steady for PRE_CLICK_DWELL_MS afterwards lets the
          // animation play against source-page frames before the real
          // click triggers navigation.
          emitInteraction("click", center.x, center.y);
          await safeWait(PRE_CLICK_DWELL_MS);
          await page.mouse.click(center.x, center.y);
        } else {
          await page.click(step.selector, { timeout: 5000 });
        }
      } catch {
        // selector not found; record but don't abort
      }
      // The DOM "click" listener also fires for the real mouse.click above
      // and emits a duplicate (non-synthetic) click event. dropDuplicateDomClicks
      // removes those. After the real click, wait for the page to settle
      // (dropdown opens, date picker collapses, route loads) — replaces the
      // old fixed-budget safeWait. Ceiling = remaining expected_duration_ms
      // budget so we never wait LONGER than the plan asked for, but we
      // typically return MUCH earlier on quiet pages. min_wait covers the
      // case where the click triggers nothing visible (browser hasn't
      // painted yet, observer would otherwise read "stable" instantly).
      const postClickBudget = Math.max(
        0,
        step.expected_duration_ms - 500 - PRE_CLICK_DWELL_MS - 50,
      );
      if (postClickBudget > 0) {
        await waitForVisualStability(page, {
          timeout_ms: postClickBudget,
          stable_window_ms: 350,
          min_wait_ms: 200,
        });
      }
      break;
    }
    case "type": {
      // Move the mouse to the target field so the cursor visually lands
      // there, then click to focus, then type via keyboard.
      //
      // Why click + page.keyboard.type, NOT page.type(selector, text):
      // sites like Google Flights render duplicate inputs with the same
      // aria-label — a collapsed one and an expanded popup one. The click
      // opens the popup; typing should land in WHATEVER IS FOCUSED, which
      // is the popup input. `page.type(selector, text)` re-targets the
      // first DOM match (the collapsed one) and silently swallows typed
      // chars. Using focused-target keyboard.type is robust against this
      // class of UI (any combobox / autocomplete popup pattern).
      if (step.selector) {
        const center = await resolveCenter(step.selector);
        if (!center) {
          result.status = "selector_missed";
          result.resolved_at = null;
        } else {
          result.status = "fired";
          result.resolved_at = center;
        }
        if (center) {
          await page.mouse.move(center.x, center.y, { steps: 18 });
          // Emit a single TYPE event for this step. dropDuplicateDomClicks
          // (post-pass) will remove the DOM click that fires when we call
          // page.mouse.click below — the dedupe matches DOM clicks against
          // synthetic TYPE events too, since the focusing click and the
          // type are part of the same logical step.
          emitInteraction("type", center.x, center.y);
          await safeWait(150);
          await page.mouse.click(center.x, center.y);
        } else {
          await page.click(step.selector).catch(() => {});
        }
        // Wait for the focusing click's UI response to settle (popup
        // opens, autocomplete renders, native dropdown attaches) before
        // we start typing. Replaces the previous hardcoded `safeWait(400)`
        // — combobox-popup pages need closer to 600-800ms; simple <input>
        // fields settle in <100ms. Stability detection adapts.
        await waitForVisualStability(page, {
          timeout_ms: 1500,
          stable_window_ms: 250,
          min_wait_ms: 150,
        });
        // Clear the field's current content via select-all + delete (only
        // if there's existing content; setting empty value can rebuild
        // controlled inputs and lose focus).
        const existingValue = await page
          .$eval(step.selector, (el) => (el as HTMLInputElement).value || "")
          .catch(() => "");
        if (existingValue.length > 0) {
          await page.keyboard.press("ControlOrMeta+a").catch(() => {});
          await page.keyboard.press("Delete").catch(() => {});
        }
        await page.keyboard.type(step.value ?? "", { delay: 30 });
        // After typing, the last sampled cursor kind is whatever was at
        // the input field (typically "text" / I-beam). Without any
        // mousemove, the rendered cursor stays as an I-beam frozen on
        // the field — looks like the cursor never registered the user's
        // hand-off from typing back to "ready to click". Push a synthetic
        // cursor sample at the same coords with kind="arrow" so the
        // renderer hard-swaps the sprite away from the I-beam.
        if (center) {
          cursorSamples.push({
            t_ms: tNow(),
            x: center.x,
            y: center.y,
            kind: "arrow",
          });
        }
      }
      // After typing, wait for any post-type UI response to settle —
      // autocomplete suggestions populating, validation messages, search
      // results streaming in. Replaces the previous fixed-budget remainder
      // calculation. Ceiling matches that calculation so the recording
      // can never be longer than what the plan asked for.
      const postTypeBudget = Math.max(
        0,
        step.expected_duration_ms - (step.value ?? "").length * 30 - 550,
      );
      if (postTypeBudget > 0) {
        await waitForVisualStability(page, {
          timeout_ms: postTypeBudget,
          stable_window_ms: 350,
          min_wait_ms: 200,
        });
      }
      break;
    }
    case "scroll": {
      const sel = step.selector ?? "body";
      const center = await resolveCenter(sel);
      if (center) {
        emitInteraction("scroll", center.x, center.y);
        result.status = "fired";
        result.resolved_at = center;
      } else {
        result.status = "selector_missed";
      }
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
        result.status = "fired";
        result.resolved_at = center;
      } else if (step.selector) {
        await page.hover(step.selector, { timeout: 5000 }).catch(() => {});
        result.status = "selector_missed";
      }
      await safeWait(step.expected_duration_ms);
      break;
    }
    case "navigate": {
      // Already-fired above (this case is for completeness — flow shouldn't
      // reach here since "navigate" is the first case).
      break;
    }
    case "highlight": {
      // Camera-frames a region without clicking. The hard part is
      // TIMING: highlights typically target async-rendered content
      // (search results, dashboard widgets, AI-generated outputs) that
      // isn't immediately stable when the selector first matches.
      //
      // The recorder must give the camera's IN phase (the 700ms zoom-in
      // animation that starts BEFORE the event timestamp) a stable
      // source-time window — otherwise the camera zooms toward an
      // element that's still rendering or shifting position.
      //
      // Sequence:
      //   1. waitForSelector (state: visible) — element must exist
      //   2. waitForStableBbox — bbox unchanged across 3×150ms = 450ms
      //   3. cursor drift (slow, signals attention)
      //   4. safeWait(HIGHLIGHT_PREROLL_MS) — gives the IN phase a fully
      //      settled source-time window
      //   5. emit `highlight` event (event_t = step end of preroll)
      //   6. hold for expected_duration_ms
      //
      // The keyframe planner anchors the IN phase at event_t - duration_in_ms
      // (= step 4's start). During the IN window the page is settled.
      if (!step.selector) {
        await safeWait(step.expected_duration_ms);
        break;
      }
      // Step 1: wait for selector to be visible.
      let visible = false;
      try {
        await page.waitForSelector(step.selector, {
          state: "visible",
          timeout: 10_000,
        });
        visible = true;
      } catch {
        // selector never became visible — fail soft
      }
      if (!visible) {
        result.status = "selector_missed";
        result.resolved_at = null;
        await safeWait(step.expected_duration_ms);
        break;
      }
      // Step 2: wait for bbox stability. Layout-shift detection — only
      // proceed when the bbox has been unchanged for 3 consecutive
      // 150ms checks (≈ 450ms of stable layout).
      const stableBox = await waitForStableBbox(page, step.selector);
      if (!stableBox) {
        result.status = "selector_missed";
        result.resolved_at = null;
        await safeWait(step.expected_duration_ms);
        break;
      }
      const cx = stableBox.x + stableBox.width / 2;
      const cy = stableBox.y + stableBox.height / 2;
      result.status = "fired";
      result.resolved_at = { x: cx, y: cy };
      // Step 3: cursor drift — steps:36 reads as "deliberate attention"
      // (click uses 24, faster move).
      await page.mouse.move(cx, cy, { steps: 36 });
      // Step 4: IN-phase preroll. The camera's zoom-in animation runs
      // from event_t - duration_in_ms to event_t (default 700ms). Wait
      // long enough that the IN phase covers a stable source window AND
      // any in-flight async rendering on the rest of the page has
      // settled. Stability detection picks the actual moment the page
      // becomes quiet — typically much faster than the 700ms ceiling on
      // simple pages, but also extends correctly on slow ones (search
      // results that stream in over 1-2s after the bbox itself is stable).
      const HIGHLIGHT_PREROLL_MAX_MS = 1500;
      await waitForVisualStability(page, {
        timeout_ms: HIGHLIGHT_PREROLL_MAX_MS,
        stable_window_ms: 400,
        min_wait_ms: 300,
      });
      // Step 5: emit the event NOW (after preroll, after stability).
      events.push({
        kind: "highlight",
        t_ms: tNow(),
        x: cx,
        y: cy,
        w: stableBox.width,
        h: stableBox.height,
        step_index: stepIndex,
        note: step.note,
        no_zoom: step.no_zoom,
        synthetic: true,
      });
      // Step 6: hold for expected_duration_ms. The camera's hold phase
      // gets a stable source window of the same duration.
      await safeWait(step.expected_duration_ms);
      break;
    }
    case "wait_for_selector": {
      if (step.selector) {
        await page.waitForSelector(step.selector, { timeout: 10_000 }).catch(() => {});
        result.status = "fired";
      }
      break;
    }
    case "wait":
    default:
      await safeWait(step.expected_duration_ms);
  }
  void stepIndex;
  return result;
}
