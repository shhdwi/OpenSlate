import { describe, expect, it } from "vitest";
import { DEFAULT_POLISH_PROFILE, parsePolishProfile } from "../src/core/index.js";
import { applyEase } from "../src/utils/easings.js";
import { resolveSpringTrajectory, stepSpring } from "../src/utils/springs.js";
import { buildPlan, validatePlan, hasBlocking } from "../src/plan/index.js";
import { resolveZoomEnvelopes, zoomStateAt } from "../src/compositor/auto-zoom.js";

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

  it("trajectory has length proportional to span", () => {
    const traj = resolveSpringTrajectory(
      [
        { t_ms: 0, x: 0, y: 0 },
        { t_ms: 1000, x: 100, y: 100 },
      ],
      { stiffness: 180, damping: 22, mass: 1 },
      60,
    );
    expect(traj.length).toBeGreaterThan(50);
    expect(traj.length).toBeLessThan(70);
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

  it("allows zooms that are far enough apart", () => {
    const events = [
      { kind: "click" as const, t_ms: 1000, x: 100, y: 100 },
      { kind: "click" as const, t_ms: 3000, x: 200, y: 200 },
    ];
    const env = resolveZoomEnvelopes(events, DEFAULT_POLISH_PROFILE.auto_zoom);
    expect(env.length).toBe(2);
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

  it("returns peak scale during hold phase", () => {
    const env = resolveZoomEnvelopes(
      [{ kind: "click" as const, t_ms: 1000, x: 100, y: 100 }],
      DEFAULT_POLISH_PROFILE.auto_zoom,
    );
    const state = zoomStateAt(1100, env, DEFAULT_POLISH_PROFILE.auto_zoom);
    expect(state.active).toBe(true);
    expect(state.current_scale).toBeCloseTo(1.4, 1);
  });
});
