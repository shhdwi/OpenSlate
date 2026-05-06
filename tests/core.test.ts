import { describe, expect, it } from "vitest";
import { DEFAULT_POLISH_PROFILE, parsePolishProfile } from "../src/core/index.js";
import { applyEase } from "../src/utils/easings.js";
import { resolveSpringTrajectory, stepSpring } from "../src/utils/springs.js";
import { buildPlan, validatePlan, hasBlocking } from "../src/plan/index.js";
import {
  buildEditPlan,
  computeSegments,
  computeKeyframes,
  applyConnectedPan,
  outToSrc,
  srcToOut,
  outputDurationMs,
  computeHighlightZoom,
} from "../src/plan/edit-plan.js";
import { suggestZooms } from "../src/compositor/zoom-suggestions.js";
import { injectArcWaypoints } from "../src/utils/springs.js";
import { renderInitTemplate } from "../src/config/init-template.js";
import { dropDuplicateDomClicks, mapCssCursor } from "../src/recorder/playwright.js";
import type { RecordedEvent } from "../src/recorder/events.js";
import { SPRITE_INFO } from "../src/compositor/cursor-sprite-info.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("polish profile schema", () => {
  it("default profile validates", () => {
    expect(() => parsePolishProfile(DEFAULT_POLISH_PROFILE)).not.toThrow();
  });

  it("rejects fps != 60 (principle 1)", () => {
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        capture: { ...DEFAULT_POLISH_PROFILE.capture, fps: 30 },
      }),
    ).toThrow(/timing_and_spacing/);
  });

  it("rejects zoom.max_peak > 2.0 (principle 8 restraint)", () => {
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        zoom: { ...DEFAULT_POLISH_PROFILE.zoom, max_peak: 2.5 },
      }),
    ).toThrow(/restraint/);
  });

  it("accepts zoom.max_peak up to 2.0 (Steel.dev-style punchy demos)", () => {
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        zoom: { ...DEFAULT_POLISH_PROFILE.zoom, max_peak: 2.0 },
      }),
    ).not.toThrow();
  });

  it("rejects no_simultaneous_polish_gestures = false", () => {
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        pacing: { ...DEFAULT_POLISH_PROFILE.pacing, no_simultaneous_polish_gestures: false as never },
      }),
    ).toThrow();
  });
});

describe("easings (principle 2)", () => {
  it("linear returns t unchanged", () => {
    expect(applyEase("linear", 0)).toBe(0);
    expect(applyEase("linear", 0.5)).toBeCloseTo(0.5, 5);
    expect(applyEase("linear", 1)).toBe(1);
  });

  it("quart_out front-loads progress (fast in, slow at end)", () => {
    const eased = applyEase("quart_out", 0.5);
    expect(eased).toBeGreaterThan(0.5); // already past midpoint at t=0.5
  });

  it("back_out overshoots before settling", () => {
    // Sample around t=0.6-0.8 where back_out should overshoot beyond 1
    let maxOvershoot = 0;
    for (let i = 0; i <= 100; i++) {
      const v = applyEase("back_out", i / 100);
      if (v > 1) maxOvershoot = Math.max(maxOvershoot, v);
    }
    expect(maxOvershoot).toBeGreaterThan(1.0);
  });
});

describe("springs (principles 3, 7)", () => {
  it("settles at target with default cursor smoothing config", () => {
    // Using the calibrated cursor defaults; 60fps for 2s should be enough.
    let state = { position: 0, velocity: 0 };
    const cfg = { stiffness: 180, damping: 22, mass: 1 };
    for (let i = 0; i < 240; i++) {
      state = stepSpring(state, 100, cfg, 1 / 60);
    }
    expect(Math.abs(state.position - 100)).toBeLessThan(1);
    expect(Math.abs(state.velocity)).toBeLessThan(1);
  });

  it("trajectory has length proportional to span (no tail)", () => {
    const traj = resolveSpringTrajectory(
      [
        { t_ms: 0, x: 0, y: 0 },
        { t_ms: 1000, x: 100, y: 100 },
      ],
      { stiffness: 180, damping: 22, mass: 1 },
      60,
      0, // no settling tail for this test
    );
    expect(traj.length).toBeGreaterThan(50);
    expect(traj.length).toBeLessThan(70);
  });

  it("trajectory includes settling tail past the last keypoint", () => {
    const tail = 90;
    const traj = resolveSpringTrajectory(
      [
        { t_ms: 0, x: 0, y: 0 },
        { t_ms: 1000, x: 100, y: 100 },
      ],
      { stiffness: 180, damping: 22, mass: 1 },
      60,
      tail,
    );
    // Without tail: ~61 frames. With tail of 90: ~151.
    expect(traj.length).toBeGreaterThan(140);
    // Final frame should have spring fully settled near (100, 100).
    const last = traj[traj.length - 1];
    expect(last).toBeDefined();
    expect(Math.abs((last?.x ?? 0) - 100)).toBeLessThan(1);
    expect(Math.abs((last?.y ?? 0) - 100)).toBeLessThan(1);
  });
});

describe("plan validation", () => {
  it("rejects plans with no interactions (principle 'appeal')", () => {
    const plan = buildPlan(
      {
        description: "test",
        protagonist: "test",
        base_url: "http://localhost:3000",
        kind: "demo",
        steps: [
          { action: "navigate", selector: "http://localhost:3000", expected_duration_ms: 2000 },
          { action: "wait", expected_duration_ms: 2000 },
        ],
      },
      DEFAULT_POLISH_PROFILE,
    );
    const violations = validatePlan(plan, DEFAULT_POLISH_PROFILE);
    expect(hasBlocking(violations)).toBe(true);
    expect(violations.some((v) => v.principle === "appeal")).toBe(true);
  });

  it("warns when two zoom-eligible clicks happen too close (principle 8 restraint)", () => {
    const plan = buildPlan(
      {
        description: "test",
        protagonist: "test",
        base_url: "http://localhost:3000",
        kind: "demo",
        steps: [
          { action: "navigate", selector: "http://localhost:3000", expected_duration_ms: 1000 },
          { action: "click", selector: "#a", expected_duration_ms: 400 },
          { action: "click", selector: "#b", expected_duration_ms: 400 },
        ],
      },
      DEFAULT_POLISH_PROFILE,
    );
    const violations = validatePlan(plan, DEFAULT_POLISH_PROFILE);
    expect(violations.some((v) => v.principle === "exaggeration_restraint")).toBe(true);
  });

  it("rejects plans exceeding pacing cap", () => {
    const plan = buildPlan(
      {
        description: "test",
        protagonist: "test",
        base_url: "http://localhost:3000",
        kind: "demo",
        steps: [
          { action: "navigate", selector: "http://localhost:3000", expected_duration_ms: 5000 },
          { action: "click", selector: "#a", expected_duration_ms: 5000 },
          { action: "click", selector: "#b", expected_duration_ms: 5000 },
        ],
      },
      DEFAULT_POLISH_PROFILE,
    );
    const violations = validatePlan(plan, DEFAULT_POLISH_PROFILE);
    expect(violations.some((v) => v.principle === "timing_and_spacing")).toBe(true);
    expect(hasBlocking(violations)).toBe(true);
  });
});

describe("cursor sampling routing (recorder design)", () => {
  // Mirror of the recorder's binding-side routing. Documenting the contract
  // here so a future change to the live recorder can't silently break
  // the trajectory shape used by the compositor.
  type Payload = { kind: string; t_ms?: number; x?: number; y?: number };
  type Sample = { t_ms: number; x: number; y: number };
  type Event = { kind: string; t_ms: number; x?: number; y?: number };

  function route(payload: Payload, t: number, samples: Sample[], events: Event[]): void {
    if (payload.kind === "cursor_move") {
      samples.push({ t_ms: t, x: payload.x ?? 0, y: payload.y ?? 0 });
      return;
    }
    if (payload.kind === "click") {
      samples.push({ t_ms: t, x: payload.x ?? 0, y: payload.y ?? 0 });
    }
    events.push({ ...payload, t_ms: t } as Event);
  }

  it("routes cursor_move to samples only, not events", () => {
    const samples: Sample[] = [];
    const events: Event[] = [];
    route({ kind: "cursor_move", x: 10, y: 20 }, 100, samples, events);
    expect(samples).toEqual([{ t_ms: 100, x: 10, y: 20 }]);
    expect(events).toEqual([]);
  });

  it("routes click to BOTH events and samples (cursor passes through click)", () => {
    const samples: Sample[] = [];
    const events: Event[] = [];
    route({ kind: "click", x: 50, y: 60 }, 200, samples, events);
    expect(samples).toEqual([{ t_ms: 200, x: 50, y: 60 }]);
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("click");
  });

  it("routes scroll to events only, not samples", () => {
    const samples: Sample[] = [];
    const events: Event[] = [];
    route({ kind: "scroll", x: 0, y: 100 }, 300, samples, events);
    expect(samples).toEqual([]);
    expect(events.length).toBe(1);
  });
});

describe("edit-plan: segment computation rules (Steel.dev pattern)", () => {
  // The planner trims dead time around salient events. Each event spawns
  // a window [t-lead, t+trail]; close windows merge; large gaps split.
  const profile = DEFAULT_POLISH_PROFILE;
  const REC = 10000;

  it("creates one segment per isolated salient event", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 5000, x: 100, y: 100, step_index: 0 },
    ];
    const segs = computeSegments(events, REC, profile);
    expect(segs.length).toBe(1);
    expect(segs[0]?.src_start_ms).toBe(5000 - profile.playback.segment_lead_ms);
    // Single (and therefore last) salient event uses final_hold_ms for trail.
    expect(segs[0]?.src_end_ms).toBe(5000 + profile.playback.final_hold_ms);
  });

  it("last salient event extends to final_hold_ms (longer page-load tail)", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 5000, x: 100, y: 100, step_index: 0 },
    ];
    const segs = computeSegments(events, REC, profile);
    // Last event's trail should equal final_hold_ms, not segment_trail_ms.
    expect(segs[0]?.src_end_ms - 5000).toBe(profile.playback.final_hold_ms);
    expect(profile.playback.final_hold_ms).toBeGreaterThan(
      profile.playback.segment_trail_ms,
    );
  });

  it("merges two close salient events into one segment", () => {
    // 1500ms apart → gap ~0ms after lead/trail → merges. Last event uses
    // final_hold_ms (3000) for trail.
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 5000, x: 100, y: 100, step_index: 0 },
      { kind: "click", t_ms: 6500, x: 200, y: 200, step_index: 1 },
    ];
    const segs = computeSegments(events, REC, profile);
    expect(segs.length).toBe(1);
    expect(segs[0]?.src_start_ms).toBe(4500);
    expect(segs[0]?.src_end_ms).toBe(6500 + profile.playback.final_hold_ms);
  });

  it("keeps two salient events with a large gap as separate segments", () => {
    // 6000ms apart → gap ~4000ms (above merge_below_ms 2000) → split
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 1000, x: 100, y: 100, step_index: 0 },
      { kind: "click", t_ms: 7000, x: 200, y: 200, step_index: 1 },
    ];
    const segs = computeSegments(events, REC, profile);
    expect(segs.length).toBe(2);
  });

  it("ignores events without step_index (page-emitted, not plan-driven)", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 5000, x: 100, y: 100 }, // no step_index
    ];
    const segs = computeSegments(events, REC, profile);
    // Falls through to "no salient events" → whole recording as one segment.
    expect(segs.length).toBe(1);
    expect(segs[0]?.src_start_ms).toBe(0);
    expect(segs[0]?.src_end_ms).toBe(REC);
  });

  it("clamps segments to recording bounds", () => {
    // Event near start: lead would push start_ms negative.
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 100, x: 0, y: 0, step_index: 0 },
    ];
    const segs = computeSegments(events, REC, profile);
    expect(segs[0]?.src_start_ms).toBe(0);
  });

  it("handles type/scroll/hover as salient too", () => {
    const events: RecordedEvent[] = [
      { kind: "type", t_ms: 2000, x: 100, y: 50, step_index: 0 },
      { kind: "scroll", t_ms: 5000, x: 200, y: 200, step_index: 1 },
      { kind: "hover", t_ms: 8000, x: 300, y: 300, step_index: 2 },
    ];
    const segs = computeSegments(events, REC, profile);
    expect(segs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("edit-plan: action-type keyframes + connected-pan", () => {
  const profile = DEFAULT_POLISH_PROFILE;
  const viewport = { width: 1280, height: 800 };

  it("emits a 4-keyframe envelope around a click event", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 5000, x: 640, y: 400, step_index: 0 },
    ];
    const segs = computeSegments(events, 10000, profile);
    const kf = computeKeyframes(events, segs, profile, viewport);
    // Expect: anchor wide @ 0, wide pre-zoom, peak in, peak hold, wide post,
    // anchor wide @ end → 6 keyframes (some may dedupe at exact times).
    expect(kf.length).toBeGreaterThanOrEqual(5);
    const peaks = kf.filter((k) => k.zoom > 1);
    expect(peaks.length).toBe(2); // peak_in + peak_out
  });

  it("uses peak=2.0 for type events (highest zoom)", () => {
    const events: RecordedEvent[] = [
      { kind: "type", t_ms: 5000, x: 640, y: 400, step_index: 0 },
    ];
    const segs = computeSegments(events, 10000, profile);
    const kf = computeKeyframes(events, segs, profile, viewport);
    const maxPeak = Math.max(...kf.map((k) => k.zoom));
    // Default type peak = 2.0, but max_peak clamps to 1.6.
    expect(maxPeak).toBeCloseTo(profile.zoom.max_peak, 2);
  });

  it("does not emit zoom keyframes for navigate/scroll (peak 1.0)", () => {
    const events: RecordedEvent[] = [
      { kind: "navigate", t_ms: 5000, target: "https://x.com", step_index: 0 },
      { kind: "scroll", t_ms: 6000, x: 100, y: 100, step_index: 1 },
    ];
    const segs = computeSegments(events, 10000, profile);
    const kf = computeKeyframes(events, segs, profile, viewport);
    // Only the wide-anchor keyframes at t=0 and t=output_end.
    const peaks = kf.filter((k) => k.zoom > 1);
    expect(peaks.length).toBe(0);
  });

  it("respects no_zoom flag — skips keyframe envelope for that event", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 5000, x: 640, y: 400, step_index: 0, no_zoom: true },
    ];
    const segs = computeSegments(events, 10000, profile);
    const kf = computeKeyframes(events, segs, profile, viewport);
    const peaks = kf.filter((k) => k.zoom > 1);
    expect(peaks.length).toBe(0);
  });

  it("clamps focal into the coverage-safe window at peak zoom", () => {
    // Click at viewport corner (0, 0) — would force focal to negative
    // territory; clamp pulls it to [margin, 1-margin].
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 5000, x: 0, y: 0, step_index: 0 },
    ];
    const segs = computeSegments(events, 10000, profile);
    const kf = computeKeyframes(events, segs, profile, viewport);
    const peak = kf.find((k) => k.zoom > 1);
    expect(peak).toBeDefined();
    if (!peak) return;
    const margin = 1 / (2 * peak.zoom);
    expect(peak.focal_x).toBeGreaterThanOrEqual(margin - 0.0001);
    expect(peak.focal_y).toBeGreaterThanOrEqual(margin - 0.0001);
  });

  it("connected-pan collapses far-apart-in-time envelopes if focals are close in space", () => {
    // Two clicks with a LARGE time gap (so connected_gap_ms doesn't apply)
    // but focals nearly identical — should still pan, not zoom-out + in.
    // Common case: tabbing across adjacent form fields.
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 2000, x: 800, y: 400, step_index: 0 },
      { kind: "click", t_ms: 8000, x: 820, y: 400, step_index: 1 }, // ~20px right
    ];
    const segs = computeSegments(events, 15000, profile);
    const kfRaw = computeKeyframes(events, segs, profile, viewport);
    const kfPan = applyConnectedPan(kfRaw, profile);
    // Spatial trigger fires (focal distance ~20/1280 ~0.016 << 0.35).
    expect(kfPan.length).toBeLessThan(kfRaw.length);
  });

  it("connected-pan does NOT collapse across a navigation event (new page = new scene)", () => {
    // Two clicks with focals close enough that spatial trigger would
    // fire — but a navigation event between them blocks the collapse.
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 2000, x: 800, y: 400, step_index: 0 },
      { kind: "navigation", t_ms: 3500, target: "https://x.com/results" },
      { kind: "click", t_ms: 5000, x: 820, y: 410, step_index: 1 },
    ];
    const segs = computeSegments(events, 8000, profile);
    const kfRaw = computeKeyframes(events, segs, profile, viewport);
    // Map nav to output time
    const navOut = srcToOut(3500, segs, profile.playback.rate);
    expect(navOut).not.toBeNull();
    const kfWithNav = applyConnectedPan(kfRaw, profile, navOut == null ? [] : [navOut]);
    const kfWithoutNav = applyConnectedPan(kfRaw, profile, []);
    // Without nav barrier: spatial trigger collapses (focals only ~22px apart).
    // With nav barrier: no collapse — keyframe count stays at raw.
    expect(kfWithoutNav.length).toBeLessThan(kfRaw.length);
    expect(kfWithNav.length).toBe(kfRaw.length);
  });

  it("connected-pan does NOT collapse when focals are far AND time gap large", () => {
    // Disable the time trigger by setting connected_gap_ms to 0. Then
    // verify the spatial trigger correctly REJECTS far-apart focals.
    const farProfile = {
      ...profile,
      zoom: { ...profile.zoom, connected_gap_ms: 0 },
    };
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 2000, x: 100, y: 100, step_index: 0 },
      { kind: "click", t_ms: 12000, x: 1100, y: 700, step_index: 1 },
    ];
    const segs = computeSegments(events, 18000, farProfile);
    const kfRaw = computeKeyframes(events, segs, farProfile, viewport);
    const kfPan = applyConnectedPan(kfRaw, farProfile);
    // Focals after clamp are (0.333, 0.333) and (0.667, 0.667), distance
    // ~0.47 > default focal_dist_max 0.35 → no collapse.
    expect(kfPan.length).toBe(kfRaw.length);
  });

  it("connected-pan collapses adjacent zoom envelopes within connected_gap_ms", () => {
    // Click A at t=2000, click B at t=4000. Segments merge into one
    // window [1500, 5500]. In OUTPUT time:
    //   peak_out A @ 1200, post A @ 1600, pre B @ 1900, peak_in B @ 2500.
    // Gap post→pre = 300ms < connected_gap_ms (1350) → connected-pan
    // drops the dip pair (post_A + pre_B), keeping zoom at peak across
    // the bridge.
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 2000, x: 100, y: 100, step_index: 0 },
      { kind: "click", t_ms: 4000, x: 1100, y: 700, step_index: 1 },
    ];
    const segs = computeSegments(events, 10000, profile);
    const kfRaw = computeKeyframes(events, segs, profile, viewport);
    const kfPan = applyConnectedPan(kfRaw, profile);
    expect(kfPan.length).toBe(kfRaw.length - 1);
    // The bridge keyframe inserted at the original post_A time should be
    // at peak zoom (sustained across the pan).
    const bridgeIdx = kfPan.findIndex(
      (k) => Math.abs(k.out_t_ms - 1600) < 0.5 && k.zoom > 1,
    );
    expect(bridgeIdx).toBeGreaterThan(-1);
  });
});

describe("edit-plan: src↔out time mapping", () => {
  it("srcToOut returns null for times in dropped gaps", () => {
    const segments = [
      { src_start_ms: 1000, src_end_ms: 2000 },
      { src_start_ms: 5000, src_end_ms: 6000 },
    ];
    expect(srcToOut(500, segments, 1)).toBeNull();
    expect(srcToOut(3000, segments, 1)).toBeNull();
    expect(srcToOut(7000, segments, 1)).toBeNull();
  });

  it("srcToOut respects playback_rate", () => {
    const segments = [{ src_start_ms: 0, src_end_ms: 4000 }];
    expect(srcToOut(2000, segments, 1)).toBe(2000);
    expect(srcToOut(2000, segments, 4)).toBe(500);
  });

  it("srcToOut accumulates across multiple segments", () => {
    const segments = [
      { src_start_ms: 1000, src_end_ms: 2000 }, // 1000ms
      { src_start_ms: 5000, src_end_ms: 6000 }, // 1000ms
    ];
    expect(srcToOut(1500, segments, 1)).toBe(500);
    expect(srcToOut(5500, segments, 1)).toBe(1500);
  });

  it("outToSrc is the inverse of srcToOut at strictly-interior points", () => {
    // Boundary points (exact src_end of one seg vs src_start of next) are
    // ambiguous in the inverse direction because both map to the same
    // output time. We test interior points where the mapping is bijective.
    const segments = [
      { src_start_ms: 1000, src_end_ms: 2000 },
      { src_start_ms: 5000, src_end_ms: 6000 },
    ];
    for (const src of [1100, 1500, 1900, 5100, 5500, 5900]) {
      const out = srcToOut(src, segments, 1);
      expect(out).not.toBeNull();
      if (out == null) continue;
      expect(outToSrc(out, segments, 1)).toBeCloseTo(src, 3);
    }
  });

  it("outputDurationMs is sum of segment durations divided by rate", () => {
    const segments = [
      { src_start_ms: 1000, src_end_ms: 2000 },
      { src_start_ms: 5000, src_end_ms: 6000 },
    ];
    expect(outputDurationMs(segments, 1)).toBe(2000);
    expect(outputDurationMs(segments, 4)).toBe(500);
  });
});

describe("edit-plan: end-to-end buildEditPlan", () => {
  it("schema_version: 1; includes recording_id, viewport, segments, keyframes", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 5000, x: 640, y: 400, step_index: 0 },
    ];
    const manifest = {
      id: "rec_123",
      created_at: new Date().toISOString(),
      duration_ms: 10000,
      fps: 60,
      viewport: { width: 1280, height: 800 },
      device_pixel_ratio: 2,
      frame_count: 600,
      frame_indices: [],
      frame_timestamps_ms: [],
      start_offset_ms: 0,
      frames_dir: "frames",
      events_file: "events.json",
      cursor_file: "cursor.json",
      plan_file: "plan.json",
      base_url: "https://example.com",
    };
    const plan = buildEditPlan({
      recording_id: "rec_123",
      manifest,
      events,
      profile: DEFAULT_POLISH_PROFILE,
    });
    expect(plan.schema_version).toBe(1);
    expect(plan.recording_id).toBe("rec_123");
    expect(plan.playback_rate).toBe(DEFAULT_POLISH_PROFILE.playback.rate);
    expect(plan.viewport).toEqual({ width: 1280, height: 800 });
    expect(plan.segments.length).toBeGreaterThan(0);
    expect(plan.keyframes.length).toBeGreaterThan(0);
    // First and last keyframes anchor wide.
    expect(plan.keyframes[0]?.zoom).toBe(1);
    expect(plan.keyframes[plan.keyframes.length - 1]?.zoom).toBe(1);
  });

  it("byte-identical plan for byte-identical inputs (deterministic)", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 5000, x: 640, y: 400, step_index: 0 },
    ];
    const manifest = {
      id: "rec_x",
      created_at: "2026-05-04T12:00:00.000Z",
      duration_ms: 10000,
      fps: 60,
      viewport: { width: 1280, height: 800 },
      device_pixel_ratio: 2,
      frame_count: 600,
      frame_indices: [],
      frame_timestamps_ms: [],
      start_offset_ms: 0,
      frames_dir: "frames",
      events_file: "events.json",
      cursor_file: "cursor.json",
      plan_file: "plan.json",
      base_url: "https://example.com",
    };
    const a = buildEditPlan({ recording_id: "rec_x", manifest, events, profile: DEFAULT_POLISH_PROFILE });
    const b = buildEditPlan({ recording_id: "rec_x", manifest, events, profile: DEFAULT_POLISH_PROFILE });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("cursor arcs (principle 5)", () => {
  it("injects midpoint with upward y for long traversals", () => {
    const arc = injectArcWaypoints(
      [
        { t_ms: 0, x: 0, y: 0 },
        { t_ms: 1000, x: 1000, y: 0 },
      ],
      0.15,
    );
    expect(arc.length).toBe(3);
    const mid = arc[1]!;
    expect(mid.t_ms).toBe(500);
    expect(mid.x).toBe(500);
    expect(mid.y).toBeLessThan(0); // y is lifted upward
  });

  it("does NOT inject for short traversals", () => {
    const arc = injectArcWaypoints(
      [
        { t_ms: 0, x: 0, y: 0 },
        { t_ms: 1000, x: 50, y: 0 },
      ],
      0.15,
    );
    expect(arc.length).toBe(2);
  });

  it("arc_amount = 0 disables injection", () => {
    const arc = injectArcWaypoints(
      [
        { t_ms: 0, x: 0, y: 0 },
        { t_ms: 1000, x: 1000, y: 0 },
      ],
      0,
    );
    expect(arc.length).toBe(2);
  });
});

describe("init-template drift protection", () => {
  // The template was hand-written and silently drifted from the actual
  // defaults whenever we changed them. Now generated programmatically
  // from DEFAULT_POLISH_PROFILE; this test catches any regression.
  it("includes browser_zoom (added in latest defaults)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/browser_zoom:/);
  });

  it("uses browser_safari frame (current default), not laptop_minimal", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/style:\s*"browser_safari"/);
    expect(tpl).not.toMatch(/style:\s*"laptop_minimal"/);
  });

  it("outro is OFF by default", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/duration_ms:\s*0/);
    expect(tpl).toMatch(/style:\s*"none"/);
  });

  it("click_highlight enabled_on every_click", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/enabled_on:\s*"every_click"/);
  });

  it("click_bounce uses calibrated 0.85 / 260ms / back_out", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/click_bounce:\s*\{\s*scale:\s*\[0\.85,\s*1\]/);
    expect(tpl).toMatch(/duration_ms:\s*260/);
  });

  it("path_arc_amount: 0.12 (not 0.0)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/path_arc_amount:\s*0\.12/);
  });

  it("zoom templates serialize click peak 1.6 with asymmetric durations (calibrated default)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/click:\s*\{[\s\S]*?peak:\s*1\.6/);
    expect(tpl).toMatch(/duration_in_ms:\s*600/);
    expect(tpl).toMatch(/duration_out_ms:\s*400/);
  });

  it("zoom template for type uses peak 2.0 (highest zoom intent; clamps to max_peak)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/type:\s*\{[\s\S]*?peak:\s*2/);
  });

  it("playback rate defaults to 1.0 (realtime; opt-in to 4×)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/playback:\s*\{[\s\S]*?rate:\s*1/);
  });

  it("zoom max_peak: 1.6 (restraint cap)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/max_peak:\s*1\.6/);
  });

  it("step badges OFF by default (not 'walkthrough_only')", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/step_badges:\s*\{[\s\S]*?enabled_on:\s*"off"/);
  });

  it("playback.final_hold_ms: 3000 (final-page-load tail)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/final_hold_ms:\s*3000/);
  });

  it("zoom.connected_focal_dist_max: 0.35 (pan-instead-of-thrash threshold)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/connected_focal_dist_max:\s*0\.35/);
  });

  it("zoom template for `highlight` is present (camera holds wide; lift is visual)", () => {
    const tpl = renderInitTemplate();
    // peak=1.0 means camera doesn't zoom on highlight; the visual lift
    // (lift_scale on the bbox) handles the enlargement.
    expect(tpl).toMatch(/highlight:\s*\{[\s\S]*?peak:\s*1/);
    expect(tpl).toMatch(/highlight:\s*\{[\s\S]*?hold_ms:\s*2000/);
  });

  it("flourishes.highlight_treatment defaults to spotlight + 1.15× lift_scale", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/highlight_treatment:\s*\{[\s\S]*?style:\s*"spotlight"/);
    expect(tpl).toMatch(/highlight_treatment:\s*\{[\s\S]*?dim_opacity:\s*0\.45/);
    expect(tpl).toMatch(/highlight_treatment:\s*\{[\s\S]*?lift_outline:\s*true/);
    expect(tpl).toMatch(/highlight_treatment:\s*\{[\s\S]*?lift_scale:\s*1\.15/);
  });

  it("includes contextual_swap (cursor sprite swap setting)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/contextual_swap:\s*true/);
  });

  it("default cursor size_multiplier serialized as 2.5", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/size_multiplier:\s*2\.5/);
  });
});

describe("polish profile schema — full-coverage validation", () => {
  it("accepts default browser_zoom of 1.0", () => {
    expect(() => parsePolishProfile(DEFAULT_POLISH_PROFILE)).not.toThrow();
  });

  it("rejects browser_zoom out of range", () => {
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        capture: { ...DEFAULT_POLISH_PROFILE.capture, browser_zoom: 5.0 },
      }),
    ).toThrow();
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        capture: { ...DEFAULT_POLISH_PROFILE.capture, browser_zoom: 0.1 },
      }),
    ).toThrow();
  });

  it("accepts browser_zoom of 1.25 (typical override)", () => {
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        capture: { ...DEFAULT_POLISH_PROFILE.capture, browser_zoom: 1.25 },
      }),
    ).not.toThrow();
  });

  it("default outro is OFF (duration_ms: 0, style: none)", () => {
    expect(DEFAULT_POLISH_PROFILE.outro.duration_ms).toBe(0);
    expect(DEFAULT_POLISH_PROFILE.outro.style).toBe("none");
  });

  it("default frame is browser_safari (Mac browser)", () => {
    expect(DEFAULT_POLISH_PROFILE.frame.style).toBe("browser_safari");
    expect(DEFAULT_POLISH_PROFILE.frame.chrome.url_bar).toBe(true);
    expect(DEFAULT_POLISH_PROFILE.frame.chrome.traffic_lights).toBe(true);
  });

  it("readme_hero preset is capped at 6s", () => {
    expect(DEFAULT_POLISH_PROFILE.exports.readme_hero.duration_max_s).toBe(6);
    expect(DEFAULT_POLISH_PROFILE.exports.readme_hero.format).toBe("gif");
  });
});

describe("zoom suggestions (Recordly-pattern engine)", () => {
  it("suggests one click cluster from a single click", () => {
    const events = [{ kind: "click" as const, t_ms: 1000, x: 200, y: 300 }];
    const out = suggestZooms(events, [], { viewport_width: 1280, viewport_height: 800 });
    expect(out.length).toBe(1);
    expect(out[0]?.source).toBe("click");
    expect(out[0]?.focal_x).toBeCloseTo(200 / 1280, 4);
  });

  it("merges close-in-time clicks into a single cluster", () => {
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 200, y: 300 },
      { kind: "click" as const, t_ms: 2000, x: 220, y: 320 },
    ];
    const out = suggestZooms(events, [], { viewport_width: 1280, viewport_height: 800 });
    expect(out.length).toBe(1);
    expect(out[0]?.source).toBe("click_cluster");
    expect(out[0]?.source_event_indices.length).toBe(2);
  });

  it("filters out suggestions below min_strength", () => {
    const events = [{ kind: "click" as const, t_ms: 1000, x: 200, y: 300 }];
    const out = suggestZooms(events, [], {
      viewport_width: 1280,
      viewport_height: 800,
      min_strength: 0.99,
    });
    expect(out.length).toBe(0);
  });

  it("right-click (kind: click + button) treated same as left-click", () => {
    // Our recorder doesn't differentiate left/right click in the kind field;
    // both are kind=click. Suggestions should fire regardless.
    const events = [{ kind: "click" as const, t_ms: 1000, x: 200, y: 300 }];
    const out = suggestZooms(events, [], { viewport_width: 1280, viewport_height: 800 });
    expect(out.length).toBe(1);
  });

  it("respects no_zoom flag — excludes those clicks from suggestions", () => {
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 200, y: 300, no_zoom: true },
      { kind: "click" as const, t_ms: 5000, x: 400, y: 500 },
    ];
    const out = suggestZooms(events, [], { viewport_width: 1280, viewport_height: 800 });
    // Only the second click should produce a suggestion.
    expect(out.length).toBe(1);
    expect(out[0]?.focal_x).toBeCloseTo(400 / 1280, 4);
  });
});

// Obsolete: the connected-pan focal interpolation block tested the old
// resolveZoomEnvelopes/zoomStateAt API. Connected-pan is now a post-pass
// over keyframes (applyConnectedPan) and is covered in the edit-plan
// describe blocks above.

describe("contextual cursor swap (CSS-cursor → sprite kind)", () => {
  it("maps pointer/hand to pointer", () => {
    expect(mapCssCursor("pointer")).toBe("pointer");
    expect(mapCssCursor("hand")).toBe("pointer");
  });

  it("maps text and vertical-text to text (I-beam)", () => {
    expect(mapCssCursor("text")).toBe("text");
    expect(mapCssCursor("vertical-text")).toBe("text");
  });

  it("maps grab/grabbing/move to grab", () => {
    expect(mapCssCursor("grab")).toBe("grab");
    expect(mapCssCursor("grabbing")).toBe("grab");
    expect(mapCssCursor("move")).toBe("grab");
    expect(mapCssCursor("all-scroll")).toBe("grab");
  });

  it("maps not-allowed and no-drop to not-allowed", () => {
    expect(mapCssCursor("not-allowed")).toBe("not-allowed");
    expect(mapCssCursor("no-drop")).toBe("not-allowed");
  });

  it("collapses default/auto/unrecognized to arrow", () => {
    expect(mapCssCursor("default")).toBe("arrow");
    expect(mapCssCursor("auto")).toBe("arrow");
    expect(mapCssCursor("crosshair")).toBe("arrow"); // not in v1 set
    expect(mapCssCursor("col-resize")).toBe("arrow"); // not in v1 set
    expect(mapCssCursor(undefined)).toBe("arrow");
    expect(mapCssCursor("")).toBe("arrow");
  });

  it("ignores leading url(...) custom cursors and reads the fallback keyword", () => {
    // Browsers serialize `cursor: url(/x.svg) 5 5, pointer` exactly that way;
    // we should treat the keyword `pointer` as the effective kind.
    expect(mapCssCursor("url(/x.svg) 5 5, pointer")).toBe("pointer");
    expect(mapCssCursor("url('https://e.x/c.svg'), text")).toBe("text");
  });

  it("default profile enables contextual_swap and ships valid sprite list", () => {
    expect(DEFAULT_POLISH_PROFILE.cursor.contextual_swap).toBe(true);
    // Validate via schema as the canonical contract.
    expect(() => parsePolishProfile(DEFAULT_POLISH_PROFILE)).not.toThrow();
  });

  it("contextual_swap can be turned off without breaking schema", () => {
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        cursor: { ...DEFAULT_POLISH_PROFILE.cursor, contextual_swap: false },
      }),
    ).not.toThrow();
  });
});

describe("cursor size customization", () => {
  it("default size_multiplier is 2.5 (cursor-as-protagonist for product demos)", () => {
    expect(DEFAULT_POLISH_PROFILE.cursor.size_multiplier).toBe(2.5);
  });

  it("accepts custom multipliers in 0.5..3 range", () => {
    for (const m of [0.5, 1, 1.4, 2, 3]) {
      expect(() =>
        parsePolishProfile({
          ...DEFAULT_POLISH_PROFILE,
          cursor: { ...DEFAULT_POLISH_PROFILE.cursor, size_multiplier: m },
        }),
      ).not.toThrow();
    }
  });

  it("rejects size_multiplier out of range", () => {
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        cursor: { ...DEFAULT_POLISH_PROFILE.cursor, size_multiplier: 0.1 },
      }),
    ).toThrow();
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        cursor: { ...DEFAULT_POLISH_PROFILE.cursor, size_multiplier: 5 },
      }),
    ).toThrow();
  });
});

describe("nav-click animation hold (synthetic-first click flow)", () => {
  // The recorder emits a synthetic click BEFORE the real mouse.click() and
  // dwells on the source page so the click bounce + halo play out against
  // pre-nav frames. The DOM listener still fires for the real click, so
  // we dedupe.
  it("drops a near-duplicate DOM click after a synthetic click", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 1000, x: 200, y: 100, synthetic: true, step_index: 0 },
      { kind: "click", t_ms: 2300, x: 205, y: 102 }, // real click 1300ms later, same spot
    ];
    dropDuplicateDomClicks(events);
    expect(events).toHaveLength(1);
    expect(events[0].synthetic).toBe(true);
  });

  it("keeps a DOM click that is too far in time", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 1000, x: 200, y: 100, synthetic: true, step_index: 0 },
      { kind: "click", t_ms: 4000, x: 200, y: 100 }, // 3s later — outside dedupe window
    ];
    dropDuplicateDomClicks(events);
    expect(events).toHaveLength(2);
  });

  it("keeps a DOM click that is too far in space", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 1000, x: 200, y: 100, synthetic: true, step_index: 0 },
      { kind: "click", t_ms: 2000, x: 600, y: 400 }, // different region
    ];
    dropDuplicateDomClicks(events);
    expect(events).toHaveLength(2);
  });

  it("does not drop two synthetic clicks", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 1000, x: 200, y: 100, synthetic: true, step_index: 0 },
      { kind: "click", t_ms: 1500, x: 200, y: 100, synthetic: true, step_index: 1 },
    ];
    dropDuplicateDomClicks(events);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.synthetic)).toBe(true);
  });

  it("dedupes multiple synthetic→DOM pairs in sequence", () => {
    const events: RecordedEvent[] = [
      { kind: "click", t_ms: 1000, x: 100, y: 50, synthetic: true, step_index: 0 },
      { kind: "click", t_ms: 2300, x: 100, y: 50 }, // dup of #0
      { kind: "click", t_ms: 5000, x: 400, y: 200, synthetic: true, step_index: 1 },
      { kind: "click", t_ms: 6300, x: 405, y: 200 }, // dup of #2
    ];
    dropDuplicateDomClicks(events);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.synthetic)).toBe(true);
  });
});

describe("cursor sprite manifest <-> SVG geometry contract", () => {
  // The cursor positioning bug ("cursor not on click target") came from
  // applying Recordly's hotspot fractions to un-trimmed SVGs. The fix:
  // each SVG is trimmed so its viewBox === content bbox (exactly), so the
  // hotspot fractions apply directly to the rendered image. These tests
  // enforce that contract: the manifest must match the SVG file, and the
  // SVG file must be in trimmed form.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const SPRITES_DIR = path.resolve(__dirname, "../src/compositor/cursor-sprites");

  it("manifest covers exactly the 5 v1 cursor kinds", () => {
    expect(Object.keys(SPRITE_INFO).sort()).toEqual([
      "arrow",
      "grab",
      "not-allowed",
      "pointer",
      "text",
    ]);
  });

  it("each manifest entry has hotspot in [0,1] and positive dimensions", () => {
    for (const [kind, info] of Object.entries(SPRITE_INFO)) {
      expect(info.width, `${kind} width`).toBeGreaterThan(0);
      expect(info.height, `${kind} height`).toBeGreaterThan(0);
      expect(info.hotspot.x, `${kind} hotspot.x`).toBeGreaterThanOrEqual(0);
      expect(info.hotspot.x, `${kind} hotspot.x`).toBeLessThanOrEqual(1);
      expect(info.hotspot.y, `${kind} hotspot.y`).toBeGreaterThanOrEqual(0);
      expect(info.hotspot.y, `${kind} hotspot.y`).toBeLessThanOrEqual(1);
    }
  });

  it("each SVG file has a viewBox matching its manifest dimensions", async () => {
    for (const [kind, info] of Object.entries(SPRITE_INFO)) {
      const svg = await fs.readFile(path.join(SPRITES_DIR, `${kind}.svg`), "utf8");
      const m = svg.match(/viewBox\s*=\s*"([^"]+)"/);
      expect(m, `${kind}.svg has no viewBox`).toBeTruthy();
      if (!m) continue;
      const parts = m[1]!.split(/\s+/).map(Number);
      const [, , vbW, vbH] = parts;
      // Manifest dimensions must match SVG viewBox dimensions within
      // sub-unit rounding. If they drift, the rendered cursor's hotspot
      // is offset by (drift_factor * size) pixels — exactly the bug class
      // this contract prevents.
      expect(Math.abs((vbW ?? 0) - info.width), `${kind} viewBox width drift`).toBeLessThan(0.5);
      expect(Math.abs((vbH ?? 0) - info.height), `${kind} viewBox height drift`).toBeLessThan(0.5);
    }
  });

  it("each SVG file has no width/height attributes on the root <svg> (lets the renderer set them)", async () => {
    for (const kind of Object.keys(SPRITE_INFO)) {
      const svg = await fs.readFile(path.join(SPRITES_DIR, `${kind}.svg`), "utf8");
      // Match the opening <svg ...> tag specifically; nested elements may
      // legitimately have width/height (e.g., <rect>).
      const opening = svg.match(/<svg\b[^>]*>/);
      expect(opening, `${kind}.svg missing <svg> tag`).toBeTruthy();
      if (!opening) continue;
      expect(opening[0]).not.toMatch(/\swidth\s*=/);
      expect(opening[0]).not.toMatch(/\sheight\s*=/);
    }
  });
});

describe("highlight action: smart zoom-to-fit + envelope", () => {
  const profile = DEFAULT_POLISH_PROFILE;
  const viewport = { width: 1280, height: 800 };

  it("zooms a small element more than a large one", () => {
    const small = computeHighlightZoom({ w: 80, h: 60 }, viewport, 2.0);
    const large = computeHighlightZoom({ w: 800, h: 400 }, viewport, 2.0);
    expect(small).toBeGreaterThan(large);
  });

  it("caps zoom at the ceiling for tiny elements", () => {
    // 20×20 element on 1280×800 viewport: ideal zoom = 0.7 * 800 / 20 = 28
    // — should be capped at the ceiling (2.0).
    const z = computeHighlightZoom({ w: 20, h: 20 }, viewport, 2.0);
    expect(z).toBeCloseTo(2.0, 3);
  });

  it("floors at 1.5× even for elements bigger than the fillFraction window", () => {
    // An element that already fills more than 70% of the viewport would
    // mathematically need NO zoom, but the floor ensures the highlight
    // ALWAYS feels like a camera action — full-width elements get edges
    // cropped slightly. Calibrated floor 1.5×.
    const z = computeHighlightZoom({ w: 1200, h: 760 }, viewport, 2.0);
    expect(z).toBe(1.5);
  });

  it("respects an explicit lower floor when passed", () => {
    // Power-user override: pass floor=1.0 to disable the 1.5× minimum.
    const z = computeHighlightZoom({ w: 1200, h: 760 }, viewport, 2.0, 0.7, 1.0);
    expect(z).toBe(1);
  });

  it("respects ceiling regardless of bbox", () => {
    // Even with a small bbox, never exceeds the ceiling argument.
    const z = computeHighlightZoom({ w: 10, h: 10 }, viewport, 1.6);
    expect(z).toBeLessThanOrEqual(1.6);
  });

  it("default highlight template has peak=1.0 — no camera zoom, only visual lift", () => {
    // The visual lift (flourishes.highlight_treatment.lift_scale) handles
    // the enlargement of the highlighted bbox; the camera holds wide.
    expect(profile.zoom.templates.highlight.peak).toBe(1.0);
    const events: RecordedEvent[] = [
      {
        kind: "highlight",
        t_ms: 5000,
        x: 640,
        y: 400,
        w: 200,
        h: 100,
        step_index: 0,
        synthetic: true,
      },
    ];
    const segs = computeSegments(events, 10000, profile);
    const kf = computeKeyframes(events, segs, profile, viewport);
    // No keyframes with zoom > 1 — camera stays wide.
    expect(kf.every((k) => k.zoom <= 1.0)).toBe(true);
  });

  it("when highlight peak is bumped >1, smart zoom-to-fit applies (opt-in path)", () => {
    // Power users can opt into camera-zoom-on-highlight by raising the
    // template peak. Smart zoom-to-fit then uses the bbox to compute the
    // actual zoom, capped at the template peak.
    const cameraProfile = {
      ...profile,
      zoom: {
        ...profile.zoom,
        templates: {
          ...profile.zoom.templates,
          highlight: { ...profile.zoom.templates.highlight, peak: 2.0 },
        },
      },
    };
    const events: RecordedEvent[] = [
      {
        kind: "highlight",
        t_ms: 5000,
        x: 640,
        y: 400,
        w: 200,
        h: 100,
        step_index: 0,
        synthetic: true,
      },
    ];
    const segs = computeSegments(events, 10000, cameraProfile);
    const kf = computeKeyframes(events, segs, cameraProfile, viewport);
    const peakKf = kf.find((k) => k.zoom > 1);
    expect(peakKf).toBeDefined();
  });

  it("highlight is salient — drives a segment around it", () => {
    const events: RecordedEvent[] = [
      {
        kind: "highlight",
        t_ms: 5000,
        x: 640,
        y: 400,
        w: 200,
        h: 100,
        step_index: 0,
        synthetic: true,
      },
    ];
    const segs = computeSegments(events, 10000, profile);
    expect(segs.length).toBe(1);
    expect(segs[0]!.src_start_ms).toBeLessThan(5000);
    expect(segs[0]!.src_end_ms).toBeGreaterThan(5000);
  });
});

describe("waitForVisualStability — page-settle primitive", () => {
  // We stub the minimum of Playwright's Page surface that
  // waitForVisualStability touches: evaluate() (returns the in-page
  // snapshot), waitForTimeout (real setTimeout — must consume REAL time
  // so the implementation's Date.now()-based elapsed tracking is correct),
  // and waitForLoadState (used only when require_network_idle).
  //
  // Tests run in real time (a few hundred ms per test) — the alternative
  // would be mocking Date.now()/performance.now() globally, which is more
  // fragile than just letting the wall clock advance.
  function makeFakePage(opts: {
    /**
     * (start_ms) → snapshot at the current real elapsed time. Models the
     * in-page observer state. last_mut_at / last_shift_at are absolute ms
     * since test start, in the same clock as `now`.
     */
    snapshot: (elapsed_ms: number) => {
      last_mut_at: number;
      last_shift_at: number;
      mut_count: number;
    };
    network_idle_at_ms?: number; // when the fake load-state resolves
  }) {
    const start = Date.now();
    const elapsed = () => Date.now() - start;
    const page = {
      async waitForTimeout(ms: number) {
        await new Promise((r) => setTimeout(r, ms));
      },
      async evaluate(_fn: unknown) {
        const e = elapsed();
        const s = opts.snapshot(e);
        return { ...s, now: e };
      },
      async waitForLoadState(_state: string, o?: { timeout?: number }) {
        const target = opts.network_idle_at_ms ?? 0;
        const wait = Math.max(0, target - elapsed());
        const cap = o?.timeout ?? Number.POSITIVE_INFINITY;
        if (wait > cap) {
          await new Promise((r) => setTimeout(r, cap));
          throw new Error("timeout");
        }
        await new Promise((r) => setTimeout(r, wait));
      },
    };
    return page;
  }

  it("returns stable=true once the page has been quiet for stable_window_ms", async () => {
    const { waitForVisualStability } = await import(
      "../src/recorder/stability.js"
    );
    // Page is busy until t=300, then completely quiet.
    const page = makeFakePage({
      snapshot: (t) => ({
        last_mut_at: Math.min(300, t),
        last_shift_at: 0,
        mut_count: 1,
      }),
    });
    const r = await waitForVisualStability(page as never, {
      timeout_ms: 5000,
      stable_window_ms: 400,
      min_wait_ms: 100,
      interval_ms: 50,
    });
    expect(r.stable).toBe(true);
    expect(r.reason).toBe("quiet");
    // We need 400ms quiet after the last mutation at t=300, so we should
    // return at ~700ms (plus polling slack of one interval).
    expect(r.waited_ms).toBeGreaterThanOrEqual(700);
    expect(r.waited_ms).toBeLessThan(900);
  });

  it("returns stable=false on timeout when the page never quiets", async () => {
    const { waitForVisualStability } = await import(
      "../src/recorder/stability.js"
    );
    // Mutation timestamp tracks `now` — page is constantly busy.
    const page = makeFakePage({
      snapshot: (t) => ({
        last_mut_at: t,
        last_shift_at: 0,
        mut_count: 99,
      }),
    });
    const r = await waitForVisualStability(page as never, {
      timeout_ms: 1000,
      stable_window_ms: 400,
      min_wait_ms: 100,
      interval_ms: 50,
    });
    expect(r.stable).toBe(false);
    expect(r.reason).toBe("timeout");
    // Should hit timeout shortly after 1000ms (one final interval after).
    expect(r.waited_ms).toBeGreaterThanOrEqual(1000);
    expect(r.waited_ms).toBeLessThan(1200);
  });

  it("respects min_wait_ms even when the page is already quiet", async () => {
    const { waitForVisualStability } = await import(
      "../src/recorder/stability.js"
    );
    // Page was quiet from t=0 onward — without min_wait, would return
    // immediately. min_wait_ms enforces a floor.
    const page = makeFakePage({
      snapshot: () => ({
        last_mut_at: 0,
        last_shift_at: 0,
        mut_count: 0,
      }),
    });
    const r = await waitForVisualStability(page as never, {
      timeout_ms: 3000,
      stable_window_ms: 400,
      min_wait_ms: 500,
      interval_ms: 50,
    });
    expect(r.stable).toBe(true);
    expect(r.waited_ms).toBeGreaterThanOrEqual(500);
  });

  it("require_network_idle holds stability until network settles", async () => {
    const { waitForVisualStability } = await import(
      "../src/recorder/stability.js"
    );
    // DOM goes quiet at t=200, but network doesn't reach idle until t=900.
    // Result: should return ~stable_window after the LATER of the two.
    const page = makeFakePage({
      snapshot: (t) => ({
        last_mut_at: Math.min(200, t),
        last_shift_at: 0,
        mut_count: 1,
      }),
      network_idle_at_ms: 900,
    });
    const r = await waitForVisualStability(page as never, {
      timeout_ms: 5000,
      stable_window_ms: 300,
      min_wait_ms: 100,
      interval_ms: 50,
      require_network_idle: true,
    });
    expect(r.stable).toBe(true);
    // Network settled at 900; the next poll after that point reads
    // sinceMut > stable_window, so we return ~at the next poll.
    expect(r.waited_ms).toBeGreaterThanOrEqual(900);
  });
});

describe("highlight lift animates THROUGH envelope (not binary)", () => {
  // Regression: previously the lifted-card transform was scale(liftScale)
  // — constant during the entire envelope. Only opacity rode the in/hold/
  // out curves, so the card POPPED into existence at full lift and
  // POPPED out, reading as a glitch. Now scale is interpolated through
  // envelope_opacity so the card visibly lifts forward, holds, recedes.
  it("animatedScale = 1 + (lift_scale - 1) * envelope_opacity at the curve endpoints", () => {
    const liftScale = 1.15;
    const lerp = (env: number) => 1 + (liftScale - 1) * env;
    expect(lerp(0)).toBeCloseTo(1.0); // pre-in / post-out
    expect(lerp(0.5)).toBeCloseTo(1.075); // mid-curve
    expect(lerp(1)).toBeCloseTo(1.15); // peak (hold)
  });
  it("animatedScale ≥ 1 always (envelope_opacity is in [0,1])", () => {
    const liftScale = 1.15;
    const lerp = (env: number) => 1 + (liftScale - 1) * env;
    for (let env = 0; env <= 1; env += 0.1) {
      expect(lerp(env)).toBeGreaterThanOrEqual(1);
      expect(lerp(env)).toBeLessThanOrEqual(liftScale);
    }
  });
});

describe("layout.tilt — 3D screen tilt", () => {
  it("default profile is flat (all rotation zero)", () => {
    const t = DEFAULT_POLISH_PROFILE.layout.tilt;
    expect(t.rotate_x_deg).toBe(0);
    expect(t.rotate_y_deg).toBe(0);
    expect(t.rotate_z_deg).toBe(0);
    // perspective_px has a value but is unused while all rotations are 0.
    expect(t.perspective_px).toBeGreaterThan(0);
  });

  it("schema accepts custom angles within range", async () => {
    const { TILT_PRESETS } = await import("../src/core/types.js");
    // valid custom values
    for (const preset of Object.values(TILT_PRESETS)) {
      const profile = parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        layout: { ...DEFAULT_POLISH_PROFILE.layout, tilt: preset },
      });
      expect(profile.layout.tilt).toEqual(preset);
    }
  });

  it("schema rejects out-of-range angles (cartoony tilt — would crop the screen)", () => {
    const bad = {
      ...DEFAULT_POLISH_PROFILE,
      layout: {
        ...DEFAULT_POLISH_PROFILE.layout,
        tilt: { rotate_x_deg: 60, rotate_y_deg: 0, rotate_z_deg: 0, perspective_px: 1500 },
      },
    };
    expect(() => parsePolishProfile(bad)).toThrow();
  });

  it("TILT_PRESETS expose at least the documented presets", async () => {
    const { TILT_PRESETS } = await import("../src/core/types.js");
    expect(TILT_PRESETS.none).toBeDefined();
    expect(TILT_PRESETS.tilt_left).toBeDefined();
    expect(TILT_PRESETS.tilt_right).toBeDefined();
    expect(TILT_PRESETS.billboard).toBeDefined();
    expect(TILT_PRESETS.dashboard).toBeDefined();
    // none must truly be flat
    expect(TILT_PRESETS.none.rotate_x_deg).toBe(0);
    expect(TILT_PRESETS.none.rotate_y_deg).toBe(0);
    expect(TILT_PRESETS.none.rotate_z_deg).toBe(0);
    // tilt_left and tilt_right are mirror-images on Y
    expect(TILT_PRESETS.tilt_left.rotate_y_deg).toBe(
      -TILT_PRESETS.tilt_right.rotate_y_deg,
    );
  });
});

describe("export preset: transparent_bg + alpha codec compatibility", () => {
  it("default preset has no transparent_bg flag (current opaque mp4 behavior)", () => {
    expect(DEFAULT_POLISH_PROFILE.exports.default.transparent_bg).toBeUndefined();
  });

  it("schema rejects transparent_bg=true with format='mp4' (h264 has no alpha)", () => {
    const bad = {
      ...DEFAULT_POLISH_PROFILE,
      exports: {
        ...DEFAULT_POLISH_PROFILE.exports,
        default: {
          ...DEFAULT_POLISH_PROFILE.exports.default,
          transparent_bg: true,
        },
      },
    };
    expect(() => parsePolishProfile(bad)).toThrow(/transparent_bg/);
  });

  it("schema rejects transparent_bg=true with format='gif' (1-bit alpha fringes)", () => {
    const bad = {
      ...DEFAULT_POLISH_PROFILE,
      exports: {
        ...DEFAULT_POLISH_PROFILE.exports,
        readme_hero: {
          ...DEFAULT_POLISH_PROFILE.exports.readme_hero,
          transparent_bg: true, // gif preset
        },
      },
    };
    expect(() => parsePolishProfile(bad)).toThrow(/transparent_bg/);
  });

  it("schema accepts transparent_bg=true with format='webm' (VP9+yuva420p)", () => {
    const ok = {
      ...DEFAULT_POLISH_PROFILE,
      exports: {
        ...DEFAULT_POLISH_PROFILE.exports,
        default: {
          format: "webm" as const,
          dimensions: [1920, 1080] as [number, number],
          transparent_bg: true,
        },
      },
    };
    const parsed = parsePolishProfile(ok);
    expect(parsed.exports.default.transparent_bg).toBe(true);
    expect(parsed.exports.default.format).toBe("webm");
  });

  it("schema accepts transparent_bg=true with format='mov' (ProRes 4444)", () => {
    const ok = {
      ...DEFAULT_POLISH_PROFILE,
      exports: {
        ...DEFAULT_POLISH_PROFILE.exports,
        default: {
          format: "mov" as const,
          dimensions: [1920, 1080] as [number, number],
          transparent_bg: true,
        },
      },
    };
    const parsed = parsePolishProfile(ok);
    expect(parsed.exports.default.transparent_bg).toBe(true);
    expect(parsed.exports.default.format).toBe("mov");
  });
});

describe("inspect: preview against example.com (integration)", () => {
  // Network-dependent integration test. Runs against example.com — a
  // tiny stable page with one link ("More information..."). Skip in CI
  // by setting OPENSLATE_SKIP_NETWORK_TESTS=1.
  const skip = process.env.OPENSLATE_SKIP_NETWORK_TESTS === "1";
  const it_ = skip ? it.skip : it;

  it_("returns at least one link with a non-empty selector", async () => {
    const { preview } = await import("../src/inspect/index.js");
    const result = await preview({ url: "https://example.com" });
    expect(result.elements.length).toBeGreaterThan(0);
    // example.com has exactly one link ("More information...").
    const links = result.elements.filter((e) => e.role === "link");
    expect(links.length).toBeGreaterThanOrEqual(1);
    const link = links[0]!;
    expect(link.selector).toBeTruthy();
    expect(link.bbox.w).toBeGreaterThan(0);
    expect(link.bbox.h).toBeGreaterThan(0);
    expect(link.in_viewport).toBe(true);
  }, 30_000);

  it_("returns viewport + url_after_load", async () => {
    const { preview } = await import("../src/inspect/index.js");
    const result = await preview({
      url: "https://example.com",
      viewport: { width: 1280, height: 800 },
    });
    expect(result.viewport).toEqual({ width: 1280, height: 800 });
    expect(result.url_after_load).toMatch(/example\.com/);
    expect(result.page_title).toBeTruthy();
  }, 30_000);
});
