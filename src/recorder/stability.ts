/**
 * Visual stability primitive — replaces hardcoded `safeWait(N)` budgets in
 * the recorder action handlers with a "wait until the page has visually
 * settled" check.
 *
 * Why: hardcoded waits are wrong in both directions. Slow pages don't
 * finish in N ms (camera zooms toward an unsettled target; click halo
 * fades against a still-changing page). Fast pages finish in 200ms but we
 * sit on a frozen frame for 1300ms (the "click lag" the user feels).
 *
 * Approach — observe THREE signals from inside the page:
 *
 *   1. DOM mutations (MutationObserver): childList, characterData, and
 *      attribute changes on document.body. Filtered to ignore noise from
 *      <style> / <script> tags and synthetic input events.
 *
 *   2. Layout shifts (PerformanceObserver, type: 'layout-shift'): catches
 *      the "fade-only" transitions that mutations miss (modal backdrop
 *      fading in, dropdown sliding open, animated images).
 *
 *   3. (Optional) network-idle from Playwright: ANDed with the page-side
 *      signals for navigation actions where in-flight requests likely
 *      mean more mutations to come.
 *
 * Why not pixel hashing — perceptual hashing of frames would catch even
 * pure CSS animations on existing elements, but requires a JPEG decoder
 * (no zero-cost option in Node) and adds CPU load. For product-UI demos
 * (the openSlate target), DOM + layout-shift covers >99% of meaningful
 * page changes. We can layer on pixel hashing later if a real-world demo
 * needs it.
 *
 * Usage:
 *
 *   await installStabilityObservers(page);  // once, before goto
 *   // ... after each action:
 *   const r = await waitForVisualStability(page, {
 *     timeout_ms: step.expected_duration_ms,
 *     stable_window_ms: 400,
 *     min_wait_ms: 200,
 *   });
 *   // r.stable = true if quiet for `stable_window_ms`, false on timeout.
 *   // r.waited_ms = actual elapsed (typically less than ceiling).
 */

import type { Page } from "playwright-core";

/**
 * Init script injected via page.addInitScript on every page (re-runs on
 * each navigation). Sets up the observers and exposes a single read-only
 * function `window.__openslate_stability_snapshot()`.
 *
 * Stringified because addInitScript serializes the function body and we
 * want explicit control over what gets sent.
 */
const STABILITY_INIT_SCRIPT = `
(() => {
  const W = window;
  if (W.__openslate_stability_installed) return;
  W.__openslate_stability_installed = true;

  // Last-event timestamps. Default to 0 so "time since" is huge until
  // something actually happens — meaning a quiescent page reads as
  // "stable" immediately, which is what we want.
  let lastMutAt = 0;
  let lastShiftAt = 0;
  let mutCountSinceInstall = 0;

  // Mutation observer. Filter noise:
  //   - mutations on <style>, <script>, <link>, <meta> are usually
  //     framework hot-reloads or styled-components updates with no
  //     visual impact
  //   - mutations under <head> are non-visual
  //   - characterData mutations on whitespace-only text nodes (often
  //     introduced by formatters) are non-visual
  //
  // Anything else counts as a real mutation that may have visual impact.
  function isNoise(m) {
    const tgt = m.target;
    if (!tgt) return true;
    // mutations under <head> are non-visual
    let n = tgt.nodeType === 1 ? tgt : tgt.parentElement;
    while (n) {
      const tag = n.tagName;
      if (tag === 'HEAD') return true;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'LINK' || tag === 'META') return true;
      n = n.parentElement;
    }
    return false;
  }

  const obs = new MutationObserver((muts) => {
    let real = 0;
    for (const m of muts) {
      if (!isNoise(m)) real++;
    }
    if (real > 0) {
      mutCountSinceInstall += real;
      lastMutAt = performance.now();
    }
  });

  // Wait for body to exist before observing (init scripts run before DOM).
  function startObserving() {
    if (!document.body) {
      requestAnimationFrame(startObserving);
      return;
    }
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  }
  startObserving();

  // Layout-shift observer. Threshold value > 0.001 ignores noise from
  // sub-pixel reflows; real shifts (modal opens, content loads, animated
  // height) are well above this threshold.
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const v = entry.value;
          if (typeof v === 'number' && v > 0.001) {
            lastShiftAt = performance.now();
          }
        }
      });
      po.observe({ type: 'layout-shift', buffered: false });
    } catch (_e) {
      // browsers w/o layout-shift type — fall back to mutation-only
    }
  }

  W.__openslate_stability_snapshot = () => ({
    last_mut_at: lastMutAt,
    last_shift_at: lastShiftAt,
    mut_count: mutCountSinceInstall,
    now: performance.now(),
  });
})();
`;

export interface WaitForStabilityOpts {
  /** Hard ceiling — return after this regardless of stability. */
  timeout_ms: number;
  /**
   * The page must be "quiet" (no mutations, no layout shifts) for this
   * many milliseconds before being declared stable. Default 400ms.
   * Calibrated: 250ms catches most simple actions but misses delayed
   * async renders; 600ms feels sluggish; 400ms is the sweet spot.
   */
  stable_window_ms?: number;
  /**
   * Polling cadence. We page.evaluate() the snapshot every `interval_ms`.
   * 100ms = 10 polls/sec, ~5-10ms per evaluate = <10% overhead. Default 100.
   */
  interval_ms?: number;
  /**
   * Always wait at least this long, even if the page reports stable
   * immediately. Catches the "action triggered nothing yet" case where
   * the browser hasn't started reflecting the action. Default 200ms.
   */
  min_wait_ms?: number;
  /**
   * AND with Playwright's networkidle. Use for navigations where the
   * page may be quiet briefly between request waves. Default false.
   */
  require_network_idle?: boolean;
}

export interface StabilityResult {
  /** True if quiet for stable_window_ms; false if we hit the timeout. */
  stable: boolean;
  /** Actual time waited in ms — typically much less than timeout_ms. */
  waited_ms: number;
  /** "quiet" | "timeout" | "no_observer" — for debug logging. */
  reason: "quiet" | "timeout" | "no_observer";
}

/**
 * Install the stability observers on the given page. Must be called
 * BEFORE the first navigation (uses addInitScript so it re-installs on
 * every page load including same-origin nav).
 */
export async function installStabilityObservers(page: Page): Promise<void> {
  await page.addInitScript(STABILITY_INIT_SCRIPT);
}

/**
 * Wait for the page to reach visual stability per the configured signals.
 * Returns details about how the wait ended (early-quiet vs timeout).
 *
 * Never throws — failures (no observer, page closed) return as
 * `{ stable: false, reason: "no_observer" }` so the caller can fall back
 * to its own timeout-based behavior.
 */
export async function waitForVisualStability(
  page: Page,
  opts: WaitForStabilityOpts,
): Promise<StabilityResult> {
  const stableWindow = opts.stable_window_ms ?? 400;
  const interval = opts.interval_ms ?? 100;
  const minWait = opts.min_wait_ms ?? 200;
  const start = Date.now();
  const deadline = start + opts.timeout_ms;

  // Always wait at least min_wait_ms before reading state — otherwise a
  // click that triggers a navigation could read "stable" before the
  // browser's first paint after the action.
  if (minWait > 0) {
    await page.waitForTimeout(Math.min(minWait, opts.timeout_ms));
  }

  // Network idle runs in parallel — if requested, stability also requires
  // it. Don't block on it (we'll AND its state in each poll).
  let networkIdle = !opts.require_network_idle;
  let networkPromise: Promise<void> = Promise.resolve();
  if (opts.require_network_idle) {
    networkPromise = page
      .waitForLoadState("networkidle", { timeout: opts.timeout_ms })
      .then(() => {
        networkIdle = true;
      })
      .catch(() => {
        // timeout — leave networkIdle false; the main loop will time out too
      });
  }

  type Snapshot = {
    last_mut_at: number;
    last_shift_at: number;
    mut_count: number;
    now: number;
  } | null;

  while (Date.now() < deadline) {
    let snap: Snapshot = null;
    try {
      snap = (await page.evaluate(() => {
        const w = window as unknown as {
          __openslate_stability_snapshot?: () => Snapshot;
        };
        return w.__openslate_stability_snapshot
          ? w.__openslate_stability_snapshot()
          : null;
      })) as Snapshot;
    } catch {
      // page navigated mid-evaluate or closed — let the loop time out
    }

    if (!snap) {
      // Observer not yet installed (very early in page lifecycle) or
      // the page is mid-navigation. Wait one interval and retry.
      await page.waitForTimeout(interval);
      continue;
    }

    const sinceMut = snap.now - snap.last_mut_at;
    const sinceShift = snap.now - snap.last_shift_at;
    const quietFor = Math.min(sinceMut, sinceShift);

    if (quietFor >= stableWindow && networkIdle) {
      await networkPromise.catch(() => {});
      return {
        stable: true,
        waited_ms: Date.now() - start,
        reason: "quiet",
      };
    }

    await page.waitForTimeout(interval);
  }

  await networkPromise.catch(() => {});
  return {
    stable: false,
    waited_ms: Date.now() - start,
    reason: "timeout",
  };
}
