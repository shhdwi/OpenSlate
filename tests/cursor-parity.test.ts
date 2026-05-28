/**
 * Cursor-math parity tests. Mirrors the structure of camera-parity:
 * known inputs → known outputs + a brute-force reference at 1000 random
 * times. Catches drift if anyone reimplements cursor sampling locally
 * instead of using the shared `sampleCursorAtSrcTime` /
 * `sampleCursorAtOutTime` from `src/compositor/cursor-math.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  sampleCursorAtOutTime,
  sampleCursorAtSrcTime,
} from "../src/compositor/cursor-math.js";
import type { EditPlan } from "../src/plan/edit-plan.js";
import type { CursorSample } from "../src/recorder/events.js";

const SAMPLES: CursorSample[] = [
  { t_ms: 0, x: 0, y: 100, kind: "arrow" },
  { t_ms: 500, x: 320, y: 100, kind: "arrow" },
  { t_ms: 1000, x: 640, y: 200, kind: "pointer" },
  { t_ms: 1500, x: 960, y: 200, kind: "pointer" },
  { t_ms: 2000, x: 1280, y: 400, kind: "arrow" },
];

/** Reference: explicit linear interpolation, no binary search. */
function reference(samples: CursorSample[], src_t_ms: number) {
  if (samples.length === 0) return { x: 0, y: 0, kind: undefined as CursorSample["kind"] };
  const first = samples[0]!;
  if (src_t_ms <= first.t_ms) return { x: first.x, y: first.y, kind: first.kind };
  const last = samples[samples.length - 1]!;
  if (src_t_ms >= last.t_ms) return { x: last.x, y: last.y, kind: last.kind };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (src_t_ms <= b.t_ms) {
      const u = (src_t_ms - a.t_ms) / Math.max(0.001, b.t_ms - a.t_ms);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, kind: b.kind };
    }
  }
  return { x: last.x, y: last.y, kind: last.kind };
}

describe("cursor parity", () => {
  it("returns the first sample for t before start", () => {
    const r = sampleCursorAtSrcTime(SAMPLES, -100);
    expect(r.x).toBe(0);
    expect(r.y).toBe(100);
    expect(r.kind).toBe("arrow");
  });

  it("returns the last sample for t past end", () => {
    const r = sampleCursorAtSrcTime(SAMPLES, 9_999);
    expect(r.x).toBe(1280);
    expect(r.y).toBe(400);
  });

  it("interpolates linearly between samples", () => {
    // Halfway between sample[0] (0,100) and sample[1] (320,100): t=250
    const r = sampleCursorAtSrcTime(SAMPLES, 250);
    expect(r.x).toBeCloseTo(160, 6);
    expect(r.y).toBeCloseTo(100, 6);
  });

  it("matches reference at 1000 deterministic random times", () => {
    let seed = 0xc0ffee;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 1000; i++) {
      const t = rand() * 2200 - 100;
      const a = sampleCursorAtSrcTime(SAMPLES, t);
      const b = reference(SAMPLES, t);
      expect(a.x).toBeCloseTo(b.x, 10);
      expect(a.y).toBeCloseTo(b.y, 10);
    }
  });

  it("sampleCursorAtOutTime maps output to source then samples", () => {
    const editPlan: Pick<EditPlan, "segments"> & { playback_rate: number } = {
      segments: [{ src_start_ms: 0, src_end_ms: 2000 }],
      playback_rate: 1,
    };
    const r = sampleCursorAtOutTime(
      SAMPLES,
      1000,
      editPlan.segments,
      editPlan.playback_rate,
    );
    expect(r).not.toBeNull();
    expect(r!.x).toBeCloseTo(640, 6);
    expect(r!.y).toBeCloseTo(200, 6);
    expect(r!.kind).toBe("pointer");
  });

  it("sampleCursorAtOutTime returns null past the segment end", () => {
    const segments = [{ src_start_ms: 0, src_end_ms: 1000 }];
    const r = sampleCursorAtOutTime(SAMPLES, 5000, segments, 1);
    expect(r).toBeNull();
  });

  it("handles empty samples", () => {
    const r = sampleCursorAtSrcTime([], 1000);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.kind).toBeUndefined();
    expect(r.src_t_ms).toBeNull();
  });
});
