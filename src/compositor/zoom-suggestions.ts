/**
 * Zoom suggestion engine — analyzes a cursor + event telemetry stream and
 * suggests zoom regions the agent might want to apply. Useful for
 * "unscripted" recording mode where the agent didn't pre-plan every click,
 * or as a sanity check on agent-generated plans.
 *
 * Pattern from Recordly's timeline/zoomSuggestionUtils.ts (AGPL).
 * Implemented independently per NOTICE.md — math/heuristics adopted as
 * IDEAS, not code.
 *
 * Three phases:
 *  1. Explicit interactions — every click is a zoom-eligible candidate
 *     with strength based on whether it's followed by typing/dwell.
 *  2. Click clustering — clicks within CLUSTER_MERGE_GAP_MS merge into a
 *     single region (matches our connected-pan thresholds upstream).
 *  3. Dwell detection — cursor sitting still within DWELL_MOVE_THRESHOLD
 *     for ≥ MIN_DWELL_MS surfaces a candidate (reading / decision-making).
 *
 * Output: list of suggested ZoomSuggestion objects. The agent decides
 * which to honor.
 */

import type { CursorSample, RecordedEvent } from "../recorder/events.js";

const CLUSTER_MERGE_GAP_MS = 2500;
const CLUSTER_PAD_MS = 500;

const MIN_DWELL_MS = 450;
const MAX_DWELL_MS = 2600;
/** Normalized cursor distance below which the cursor is "still". */
const DWELL_MOVE_THRESHOLD = 0.02;

export interface ZoomSuggestion {
  /** ms from start of recording */
  start_ms: number;
  end_ms: number;
  /** normalized [0, 1] focal in viewport coords */
  focal_x: number;
  focal_y: number;
  /** strength 0..1; agent can use to filter weak suggestions */
  strength: number;
  /** what triggered this suggestion */
  source: "click" | "click_cluster" | "dwell" | "double_click";
  /** indices into the input events array (when source is click/cluster) */
  source_event_indices: number[];
}

export interface SuggestZoomsOptions {
  viewport_width: number;
  viewport_height: number;
  /** drop suggestions whose strength is below this; default 0.3 */
  min_strength?: number;
}

export function suggestZooms(
  events: RecordedEvent[],
  cursor_samples: CursorSample[],
  opts: SuggestZoomsOptions,
): ZoomSuggestion[] {
  const min_strength = opts.min_strength ?? 0.3;
  const W = opts.viewport_width;
  const H = opts.viewport_height;

  const suggestions: ZoomSuggestion[] = [];

  // ── Phase 1+2: cluster click events by proximity in time. ────────────
  const clicks = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.kind === "click" && !e.no_zoom);

  type Cluster = {
    indices: number[];
    start_t: number;
    end_t: number;
    cx_sum: number;
    cy_sum: number;
    n: number;
    has_typing_after: boolean;
  };
  const clusters: Cluster[] = [];

  for (const { e, i } of clicks) {
    const last = clusters[clusters.length - 1];
    const within_gap = last && e.t_ms - last.end_t < CLUSTER_MERGE_GAP_MS;
    if (last && within_gap) {
      last.indices.push(i);
      last.end_t = e.t_ms;
      last.cx_sum += (e.x ?? W / 2);
      last.cy_sum += (e.y ?? H / 2);
      last.n++;
    } else {
      clusters.push({
        indices: [i],
        start_t: e.t_ms,
        end_t: e.t_ms,
        cx_sum: e.x ?? W / 2,
        cy_sum: e.y ?? H / 2,
        n: 1,
        has_typing_after: false,
      });
    }
  }

  // Detect typing-after for each cluster.
  for (const c of clusters) {
    const lastClickIdx = c.indices[c.indices.length - 1] ?? 0;
    for (let j = lastClickIdx + 1; j < events.length; j++) {
      const ev = events[j];
      if (!ev) continue;
      if (ev.kind === "click") break;
      if (ev.kind === "type") {
        c.has_typing_after = true;
        break;
      }
    }
  }

  for (const c of clusters) {
    const cx = c.cx_sum / c.n / W;
    const cy = c.cy_sum / c.n / H;
    // Strength: 0.6 base + 0.2 for clusters of size > 1 + 0.2 for typing follow-up
    const strength = 0.6 + (c.n > 1 ? 0.2 : 0) + (c.has_typing_after ? 0.2 : 0);
    suggestions.push({
      start_ms: Math.max(0, c.start_t - CLUSTER_PAD_MS),
      end_ms: c.end_t + CLUSTER_PAD_MS,
      focal_x: cx,
      focal_y: cy,
      strength,
      source: c.indices.length === 1 ? "click" : "click_cluster",
      source_event_indices: c.indices,
    });
  }

  // ── Phase 3: dwell detection. ─────────────────────────────────────────
  if (cursor_samples.length > 1) {
    let dwell_start_idx = 0;
    let dwell_x = cursor_samples[0]?.x ?? 0;
    let dwell_y = cursor_samples[0]?.y ?? 0;

    const tryEmitDwell = (start_idx: number, end_idx: number) => {
      const start = cursor_samples[start_idx];
      const end = cursor_samples[end_idx];
      if (!start || !end) return;
      const dur = end.t_ms - start.t_ms;
      if (dur < MIN_DWELL_MS || dur > MAX_DWELL_MS) return;
      // Skip if a cluster already covers this time window.
      const overlapsCluster = clusters.some(
        (c) => start.t_ms < c.end_t + CLUSTER_PAD_MS && end.t_ms > c.start_t - CLUSTER_PAD_MS,
      );
      if (overlapsCluster) return;
      const strength_base = Math.min(1, dur / 1500) * 0.55;
      suggestions.push({
        start_ms: Math.max(0, start.t_ms - 200),
        end_ms: end.t_ms + 200,
        focal_x: dwell_x / W,
        focal_y: dwell_y / H,
        strength: strength_base,
        source: "dwell",
        source_event_indices: [],
      });
    };

    for (let i = 1; i < cursor_samples.length; i++) {
      const s = cursor_samples[i];
      if (!s) continue;
      const dx = (s.x - dwell_x) / W;
      const dy = (s.y - dwell_y) / H;
      const dist = Math.hypot(dx, dy);
      if (dist > DWELL_MOVE_THRESHOLD) {
        tryEmitDwell(dwell_start_idx, i - 1);
        dwell_start_idx = i;
        dwell_x = s.x;
        dwell_y = s.y;
      }
    }
    // Tail dwell.
    tryEmitDwell(dwell_start_idx, cursor_samples.length - 1);
  }

  // Filter by min_strength, sort by start_ms.
  return suggestions
    .filter((s) => s.strength >= min_strength)
    .sort((a, b) => a.start_ms - b.start_ms);
}
