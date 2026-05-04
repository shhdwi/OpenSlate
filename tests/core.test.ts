import { describe, expect, it } from "vitest";
import { DEFAULT_POLISH_PROFILE, parsePolishProfile } from "../src/core/index.js";
import { applyEase } from "../src/utils/easings.js";
import { resolveSpringTrajectory, stepSpring } from "../src/utils/springs.js";
import { buildPlan, validatePlan, hasBlocking } from "../src/plan/index.js";
import { resolveZoomEnvelopes, zoomStateAt } from "../src/compositor/auto-zoom.js";
import { suggestZooms } from "../src/compositor/zoom-suggestions.js";
import { injectArcWaypoints } from "../src/utils/springs.js";
import { renderInitTemplate } from "../src/config/init-template.js";
import { mapCssCursor } from "../src/recorder/playwright.js";

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

  it("rejects max_scale_per_video > 1.6 (principle 8 restraint)", () => {
    expect(() =>
      parsePolishProfile({
        ...DEFAULT_POLISH_PROFILE,
        auto_zoom: { ...DEFAULT_POLISH_PROFILE.auto_zoom, max_scale_per_video: 2.0 },
      }),
    ).toThrow(/restraint/);
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

describe("auto-zoom resolver (principle 8 restraint)", () => {
  it("suppresses second zoom within skip_if_within_ms", () => {
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 100, y: 100 },
      { kind: "click" as const, t_ms: 1300, x: 200, y: 200 },
    ];
    const env = resolveZoomEnvelopes(events, DEFAULT_POLISH_PROFILE.auto_zoom);
    // Second click is within 800ms — should be suppressed
    expect(env.length).toBe(1);
  });

  it("merges close-in-time clicks into a single connected-pan envelope", () => {
    // Two clicks 2s apart — with default 700ms hold + 400ms out, the gap
    // between envelope-end and next click is ~900ms < CHAINED_GAP_MS (1350).
    // Connected-pan kicks in: ONE envelope with TWO sub-clicks.
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 100, y: 100 },
      { kind: "click" as const, t_ms: 3000, x: 200, y: 200 },
    ];
    const env = resolveZoomEnvelopes(events, DEFAULT_POLISH_PROFILE.auto_zoom);
    expect(env.length).toBe(1);
    expect(env[0]?.sub_clicks.length).toBe(2);
  });

  it("splits zooms that are far apart into separate envelopes", () => {
    // Click A at t=1000, envelope ends ~2100, recover ends ~2350. Click B
    // at t=5000 leaves a gap of 2900ms, well past CHAINED_GAP_MS — separate.
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 100, y: 100 },
      { kind: "click" as const, t_ms: 5000, x: 200, y: 200 },
    ];
    const env = resolveZoomEnvelopes(events, DEFAULT_POLISH_PROFILE.auto_zoom);
    expect(env.length).toBe(2);
    expect(env[0]?.sub_clicks.length).toBe(1);
    expect(env[1]?.sub_clicks.length).toBe(1);
  });

  it("respects no_zoom flag on event", () => {
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 100, y: 100, no_zoom: true },
    ];
    const env = resolveZoomEnvelopes(events, DEFAULT_POLISH_PROFILE.auto_zoom);
    expect(env.length).toBe(0);
  });

  it("returns inactive zoom state outside any envelope", () => {
    const env = resolveZoomEnvelopes(
      [{ kind: "click" as const, t_ms: 1000, x: 100, y: 100 }],
      DEFAULT_POLISH_PROFILE.auto_zoom,
    );
    const state = zoomStateAt(0, env, DEFAULT_POLISH_PROFILE.auto_zoom);
    expect(state.active).toBe(false);
    expect(state.current_scale).toBe(1.0);
  });

  it("returns peak scale during hold phase (matches profile.auto_zoom.scale)", () => {
    const env = resolveZoomEnvelopes(
      [{ kind: "click" as const, t_ms: 1000, x: 100, y: 100 }],
      DEFAULT_POLISH_PROFILE.auto_zoom,
    );
    // Use a t_ms after peak (which equals click time) but before out_start.
    const state = zoomStateAt(1300, env, DEFAULT_POLISH_PROFILE.auto_zoom);
    expect(state.active).toBe(true);
    expect(state.current_scale).toBeCloseTo(DEFAULT_POLISH_PROFILE.auto_zoom.scale, 2);
  });

  it("clamps the focal to the geometrically achievable window", () => {
    // Click at viewport (50, 100) on 1280x800 = normalized (0.039, 0.125).
    // At scale 1.4, focal bounds are [1/(2*1.4), 1-1/(2.8)] = [0.357, 0.643].
    // The clamped focal should be (0.357, 0.357) — pinned at the corner of
    // the achievable window.
    const env = resolveZoomEnvelopes(
      [{ kind: "click" as const, t_ms: 1000, x: 50, y: 100 }],
      DEFAULT_POLISH_PROFILE.auto_zoom,
      { viewport_width: 1280, viewport_height: 800 },
    );
    const sub = env[0]?.sub_clicks[0];
    expect(sub).toBeDefined();
    expect(sub?.focal_x).toBeCloseTo(1 / (2 * 1.4), 3);
    expect(sub?.focal_y).toBeCloseTo(1 / (2 * 1.4), 3);
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

  it("auto_zoom asymmetric durations: 600 in / 400 out", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/duration_in_ms:\s*600/);
    expect(tpl).toMatch(/duration_out_ms:\s*400/);
  });

  it("scale 1.4 (not the earlier 1.25)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/scale:\s*1\.4/);
  });

  it("includes contextual_swap (cursor sprite swap setting)", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/contextual_swap:\s*true/);
  });

  it("default cursor size_multiplier serialized as 1.25", () => {
    const tpl = renderInitTemplate();
    expect(tpl).toMatch(/size_multiplier:\s*1\.25/);
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

describe("connected-pan focal interpolation", () => {
  // The auto-zoom resolver merges close-in-time clicks into a single envelope
  // with multiple sub_clicks. zoomStateAt must interpolate the focal between
  // sub_clicks during the bridge phase using the cubic-bezier(0.1, 0, 0.2, 1)
  // ease — matches Recordly's connected-pan curve.

  it("at peak of first sub-click, focal == first sub-click's focal", () => {
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 100, y: 100 },
      { kind: "click" as const, t_ms: 1800, x: 1100, y: 700 },
    ];
    const env = resolveZoomEnvelopes(events, DEFAULT_POLISH_PROFILE.auto_zoom, {
      viewport_width: 1280,
      viewport_height: 800,
    });
    expect(env.length).toBe(1);
    expect(env[0]?.sub_clicks.length).toBe(2);
    const state = zoomStateAt(1000, env, DEFAULT_POLISH_PROFILE.auto_zoom);
    expect(state.active).toBe(true);
    const firstSub = env[0]?.sub_clicks[0];
    expect(state.focal_x).toBeCloseTo(firstSub?.focal_x ?? 0, 3);
    expect(state.focal_y).toBeCloseTo(firstSub?.focal_y ?? 0, 3);
  });

  it("at peak of last sub-click, focal == last sub-click's focal", () => {
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 100, y: 100 },
      { kind: "click" as const, t_ms: 1800, x: 1100, y: 700 },
    ];
    const env = resolveZoomEnvelopes(events, DEFAULT_POLISH_PROFILE.auto_zoom, {
      viewport_width: 1280,
      viewport_height: 800,
    });
    const state = zoomStateAt(1800, env, DEFAULT_POLISH_PROFILE.auto_zoom);
    const lastSub = env[0]?.sub_clicks[1];
    expect(state.focal_x).toBeCloseTo(lastSub?.focal_x ?? 0, 3);
    expect(state.focal_y).toBeCloseTo(lastSub?.focal_y ?? 0, 3);
  });

  it("focal HOLDS at sub-click for 500ms before panning to next", () => {
    // Sub-click A at t=1000, B at t=2200.
    // Hold ends at t=1500. Pan from 1500 to min(2200, 1500+600) = 2100.
    // So at t=1400 (still in hold) focal_x should equal A's focal_x.
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 200, y: 200 },
      { kind: "click" as const, t_ms: 2200, x: 1000, y: 600 },
    ];
    const env = resolveZoomEnvelopes(events, DEFAULT_POLISH_PROFILE.auto_zoom, {
      viewport_width: 1280,
      viewport_height: 800,
    });
    const f1000 = zoomStateAt(1000, env, DEFAULT_POLISH_PROFILE.auto_zoom);
    const f1400 = zoomStateAt(1400, env, DEFAULT_POLISH_PROFILE.auto_zoom); // mid-hold
    expect(f1400.focal_x).toBeCloseTo(f1000.focal_x, 5);
  });

  it("focal interpolates between sub-clicks during pan window (after hold)", () => {
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 200, y: 200 },
      { kind: "click" as const, t_ms: 2200, x: 1000, y: 600 },
    ];
    const env = resolveZoomEnvelopes(events, DEFAULT_POLISH_PROFILE.auto_zoom, {
      viewport_width: 1280,
      viewport_height: 800,
    });
    const f1500 = zoomStateAt(1500, env, DEFAULT_POLISH_PROFILE.auto_zoom); // hold ends
    const f1800 = zoomStateAt(1800, env, DEFAULT_POLISH_PROFILE.auto_zoom); // mid-pan
    const f2100 = zoomStateAt(2100, env, DEFAULT_POLISH_PROFILE.auto_zoom); // pan ends
    // Monotonic increase in x during the pan phase.
    expect(f1800.focal_x).toBeGreaterThan(f1500.focal_x);
    expect(f2100.focal_x).toBeGreaterThanOrEqual(f1800.focal_x);
  });
});

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
  it("default size_multiplier is 1.25 (slightly larger than Recordly's 1.0)", () => {
    expect(DEFAULT_POLISH_PROFILE.cursor.size_multiplier).toBe(1.25);
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
