/**
 * Camera-math parity tests. The single source of truth is
 * `src/compositor/camera.ts`. Both the Remotion compositor and the PixiJS
 * preview engine route through it.
 *
 * These tests pin the contract: known inputs → known outputs, and a
 * brute-force reference implementation agrees with the shipping one at
 * every test time. If the shipping function ever drifts (intentional or
 * not), this test fires.
 *
 * Why both renderers will stay aligned: as long as composition.tsx
 * imports `sampleCamera` from camera.ts and the PixiJS engine imports the
 * same, there is no second implementation to drift. This test exists to
 * catch the case where someone re-derives camera math locally.
 */

import { describe, expect, it } from "vitest";
import { cameraTransform, outToSrc, sampleCamera } from "../src/compositor/camera.js";
import type { EditPlan } from "../src/plan/edit-plan.js";
import { applyEase } from "../src/utils/easings.js";

const KFs: EditPlan["keyframes"] = [
  { out_t_ms: 0, zoom: 1, focal_x: 0.5, focal_y: 0.5, ease: "cubic_out" },
  { out_t_ms: 700, zoom: 1.6, focal_x: 0.3, focal_y: 0.4, ease: "cubic_in_out" },
  { out_t_ms: 1300, zoom: 1.6, focal_x: 0.3, focal_y: 0.4, ease: "cubic_in_out" },
  { out_t_ms: 2000, zoom: 1, focal_x: 0.5, focal_y: 0.5, ease: "cubic_in_out" },
];

/**
 * Brute-force reference: explicit linear interpolation between the
 * surrounding keyframes using applyEase. Mirrors what the original
 * inline sampleCamera did in composition.tsx — kept here as a second
 * implementation so the test detects any divergence in the shared one.
 */
function referenceSampleCamera(
  keyframes: EditPlan["keyframes"],
  t_ms: number,
): { zoom: number; focal_x: number; focal_y: number } {
  if (keyframes.length === 0) return { zoom: 1, focal_x: 0.5, focal_y: 0.5 };
  if (t_ms <= keyframes[0]!.out_t_ms) {
    const k = keyframes[0]!;
    return { zoom: k.zoom, focal_x: k.focal_x, focal_y: k.focal_y };
  }
  for (let i = 1; i < keyframes.length; i++) {
    const a = keyframes[i - 1]!;
    const b = keyframes[i]!;
    if (t_ms <= b.out_t_ms) {
      const span = Math.max(0.001, b.out_t_ms - a.out_t_ms);
      const u = (t_ms - a.out_t_ms) / span;
      const eased = applyEase(b.ease, Math.max(0, Math.min(1, u)));
      return {
        zoom: a.zoom + (b.zoom - a.zoom) * eased,
        focal_x: a.focal_x + (b.focal_x - a.focal_x) * eased,
        focal_y: a.focal_y + (b.focal_y - a.focal_y) * eased,
      };
    }
  }
  const last = keyframes[keyframes.length - 1]!;
  return { zoom: last.zoom, focal_x: last.focal_x, focal_y: last.focal_y };
}

describe("camera parity", () => {
  it("matches the reference at known boundary times", () => {
    for (const t of [-100, 0, 350, 700, 1000, 1300, 1650, 2000, 9999]) {
      const a = sampleCamera(KFs, t);
      const b = referenceSampleCamera(KFs, t);
      expect(a.zoom).toBeCloseTo(b.zoom, 12);
      expect(a.focal_x).toBeCloseTo(b.focal_x, 12);
      expect(a.focal_y).toBeCloseTo(b.focal_y, 12);
    }
  });

  it("matches the reference at 1000 random times (deterministic seed)", () => {
    // LCG so the random sequence is identical across runs — failures
    // reproduce instead of being a heisenbug.
    let seed = 0xdeadbeef;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 1000; i++) {
      const t = rand() * 2200 - 100; // sweep slightly past both ends
      const a = sampleCamera(KFs, t);
      const b = referenceSampleCamera(KFs, t);
      expect(a.zoom).toBeCloseTo(b.zoom, 10);
      expect(a.focal_x).toBeCloseTo(b.focal_x, 10);
      expect(a.focal_y).toBeCloseTo(b.focal_y, 10);
    }
  });

  it("cameraTransform places the focal point at viewport center", () => {
    const viewport = { width: 1280, height: 800 };
    for (const k of KFs) {
      const t = cameraTransform(k, viewport);
      // After applying scale + translate, the focal point should land
      // at the viewport center: scale * focal_x * width + tx == width/2.
      const projected_x = t.scale * k.focal_x * viewport.width + t.translate_x;
      const projected_y = t.scale * k.focal_y * viewport.height + t.translate_y;
      expect(projected_x).toBeCloseTo(viewport.width / 2, 6);
      expect(projected_y).toBeCloseTo(viewport.height / 2, 6);
    }
  });

  it("outToSrc inverts a single-segment plan", () => {
    const segments: EditPlan["segments"] = [{ src_start_ms: 0, src_end_ms: 2000 }];
    expect(outToSrc(0, segments, 1)).toBe(0);
    expect(outToSrc(1000, segments, 1)).toBe(1000);
    expect(outToSrc(2000, segments, 1)).toBe(2000);
    // Past the end — caller should hold last frame.
    expect(outToSrc(2500, segments, 1)).toBeNull();
  });

  it("outToSrc skips trimmed gaps", () => {
    // Two segments: 0–500 and 1500–2000. Total trimmed dur = 1000ms.
    const segments: EditPlan["segments"] = [
      { src_start_ms: 0, src_end_ms: 500 },
      { src_start_ms: 1500, src_end_ms: 2000 },
    ];
    expect(outToSrc(0, segments, 1)).toBe(0);
    expect(outToSrc(499, segments, 1)).toBe(499);
    // At out=500, we're at the boundary. Mapping: src_offset=500,
    // segment 0 contains [0..500), so src=500.
    expect(outToSrc(500, segments, 1)).toBe(500);
    // At out=501, we've crossed into segment 1: src=1501.
    expect(outToSrc(501, segments, 1)).toBe(1501);
    expect(outToSrc(999, segments, 1)).toBe(1999);
  });
});
