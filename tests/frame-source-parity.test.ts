/**
 * Frame-picker parity tests. Same pattern as camera + cursor parity:
 * known boundary times + a brute-force reference at 1000 random times.
 *
 * Catches the most common porting mistake — the off-by-one on the
 * "<=" vs "<" in the binary search. Both renderers depend on this
 * being identical.
 */

import { describe, expect, it } from "vitest";
import {
  frameFileName,
  pickFrameAtOutTime,
  pickFrameAtSrcTime,
} from "../src/compositor/frame-source-math.js";
import type { EditPlan } from "../src/plan/edit-plan.js";

// Non-uniform timestamps mirroring real CDP screencast output (no
// frame on static seconds; multiple frames during animations).
const MANIFEST = {
  frame_indices: [0, 1, 2, 5, 6, 7, 8, 12, 13, 20],
  frame_timestamps_ms: [0, 16, 32, 250, 268, 286, 304, 800, 816, 1500],
};

/** Brute-force reference: linear scan. */
function reference(t: number) {
  const ts = MANIFEST.frame_timestamps_ms;
  const idx = MANIFEST.frame_indices;
  if (ts.length === 0) return null;
  if (t <= ts[0]!) return { frame_index: idx[0]!, frame_t_ms: ts[0]! };
  if (t >= ts[ts.length - 1]!) {
    return {
      frame_index: idx[idx.length - 1]!,
      frame_t_ms: ts[ts.length - 1]!,
    };
  }
  let chosen = 0;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i]! <= t) chosen = i;
    else break;
  }
  return { frame_index: idx[chosen]!, frame_t_ms: ts[chosen]! };
}

describe("frame-source parity", () => {
  it("returns first frame for t at or before recording start", () => {
    expect(pickFrameAtSrcTime(MANIFEST, -100)?.frame_index).toBe(0);
    expect(pickFrameAtSrcTime(MANIFEST, 0)?.frame_index).toBe(0);
  });

  it("returns last frame for t past recording end", () => {
    expect(pickFrameAtSrcTime(MANIFEST, 9999)?.frame_index).toBe(20);
  });

  it("picks the highest frame with timestamp <= src_t (don't show future frames)", () => {
    // Between t=32 (frame 2) and t=250 (frame 5), at t=100 the right
    // frame to display is still 2 — frame 5 didn't exist yet.
    expect(pickFrameAtSrcTime(MANIFEST, 100)?.frame_index).toBe(2);
    expect(pickFrameAtSrcTime(MANIFEST, 249)?.frame_index).toBe(2);
    expect(pickFrameAtSrcTime(MANIFEST, 250)?.frame_index).toBe(5);
  });

  it("matches reference at 1000 deterministic random times", () => {
    let seed = 0xfeedface;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 1000; i++) {
      const t = rand() * 1700 - 100;
      const a = pickFrameAtSrcTime(MANIFEST, t);
      const b = reference(t);
      expect(a?.frame_index).toBe(b?.frame_index);
      expect(a?.frame_t_ms).toBe(b?.frame_t_ms);
    }
  });

  it("returns null for manifests with no frames on disk", () => {
    expect(pickFrameAtSrcTime({ frame_indices: [], frame_timestamps_ms: [] }, 100)).toBeNull();
  });

  it("returns null for malformed manifests where the two arrays diverge", () => {
    expect(
      pickFrameAtSrcTime({ frame_indices: [0, 1, 2], frame_timestamps_ms: [0, 16] }, 50),
    ).toBeNull();
  });

  it("pickFrameAtOutTime maps via the edit-plan", () => {
    const segments: EditPlan["segments"] = [{ src_start_ms: 0, src_end_ms: 1500 }];
    expect(pickFrameAtOutTime(MANIFEST, 250, segments, 1)?.frame_index).toBe(5);
    expect(pickFrameAtOutTime(MANIFEST, 9999, segments, 1)).toBeNull(); // past end
  });

  it("frameFileName matches the recorder's six-digit zero-padded convention", () => {
    expect(frameFileName(0)).toBe("frame_000000.png");
    expect(frameFileName(123)).toBe("frame_000123.png");
    expect(frameFileName(123456)).toBe("frame_123456.png");
  });
});
