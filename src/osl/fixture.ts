/**
 * Sample fixture builder. Materializes a minimal but valid .osl bundle on
 * disk that downstream code (preview engine, exporter, tests) can consume.
 * Used by:
 *   - unit tests that need a real bundle to round-trip
 *   - the PixiJS preview demo so you can run it without an actual recording
 *   - documentation examples in /docs
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { EditPlan } from "../plan/edit-plan.js";
import type {
  CursorSample,
  RecordedEvent,
  RecordingManifest,
} from "../recorder/events.js";
import { writeBundleManifest } from "./writer.js";

const FIXTURE_FPS = 60;
const FIXTURE_DURATION_MS = 2000; // 2-second sample
const FIXTURE_W = 1280;
const FIXTURE_H = 800;

export interface BuildFixtureOptions {
  /** Directory where the bundle will be written (created if needed). */
  outDir: string;
  /** Optional title for the manifest. */
  title?: string;
}

/**
 * Build a fully-valid sample .osl bundle: a 2-second "recording" with a
 * single synthetic click event, a cursor trajectory that arcs across the
 * frame, and an edit plan that zooms toward the click at the midpoint.
 *
 * No real frames are emitted — the manifest declares `frames_dir.count = 0`
 * and `raw_capture` is absent. Consumers that need pixels generate them
 * synthetically (see the preview engine demo).
 */
export async function buildFixture(opts: BuildFixtureOptions): Promise<string> {
  const root = opts.outDir;
  await fs.mkdir(root, { recursive: true });

  // 1. Recording manifest — describes the capture window.
  //    Frame indices/timestamps are synthesized for a uniform 60fps sweep;
  //    no actual PNG frames exist (frames_dir count = 0 in the bundle
  //    manifest), so the preview engine must synthesize pixels.
  const recordingId = `fixture-${Date.now()}`;
  const frameCount = Math.round((FIXTURE_DURATION_MS / 1000) * FIXTURE_FPS);
  const frame_indices = Array.from({ length: frameCount }, (_, i) => i);
  const frame_timestamps_ms = frame_indices.map((i) => Math.round((i * 1000) / FIXTURE_FPS));
  const recordingManifest: RecordingManifest = {
    id: recordingId,
    created_at: new Date().toISOString(),
    duration_ms: FIXTURE_DURATION_MS,
    fps: FIXTURE_FPS,
    viewport: { width: FIXTURE_W, height: FIXTURE_H },
    device_pixel_ratio: 1,
    frame_count: frameCount,
    frame_indices,
    frame_timestamps_ms,
    start_offset_ms: 0,
    frames_dir: "frames",
    events_file: "events.json",
    cursor_file: "cursor.json",
    plan_file: "plan.json",
    base_url: "fixture://sample",
  };
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(recordingManifest, null, 2),
  );

  // 2. Events — a single synthetic click at t=1000ms, dead center.
  const events: RecordedEvent[] = [
    {
      kind: "navigation",
      t_ms: 0,
      target: "fixture://sample",
      step_index: 0,
      note: "Fixture start",
    },
    {
      kind: "click",
      t_ms: 1000,
      x: FIXTURE_W / 2,
      y: FIXTURE_H / 2,
      step_index: 1,
      note: "Centered click",
      is_protagonist: true,
    },
  ];
  await fs.writeFile(path.join(root, "events.json"), JSON.stringify(events, null, 2));

  // 3. Cursor trajectory — left edge → centered click → right edge,
  //    sampled at ~125 Hz (every 8 ms).
  const samples: CursorSample[] = [];
  const sampleInterval = 8;
  for (let t = 0; t <= FIXTURE_DURATION_MS; t += sampleInterval) {
    const progress = t / FIXTURE_DURATION_MS;
    const x = FIXTURE_W * progress; // sweeps left → right
    const arcHeight = 80;
    const y = FIXTURE_H / 2 + Math.sin(progress * Math.PI) * -arcHeight;
    samples.push({ t_ms: t, x, y, kind: "arrow" } as CursorSample);
  }
  await fs.writeFile(path.join(root, "cursor.json"), JSON.stringify(samples, null, 2));

  // 4. Edit plan — zoom 1× → 1.6× → 1× centered on the click.
  const editPlan: EditPlan = {
    schema_version: 1,
    recording_id: recordingId,
    playback_rate: 1,
    viewport: { width: FIXTURE_W, height: FIXTURE_H },
    segments: [{ src_start_ms: 0, src_end_ms: FIXTURE_DURATION_MS }],
    keyframes: [
      { out_t_ms: 0, zoom: 1, focal_x: 0.5, focal_y: 0.5, ease: "cubic_out" },
      { out_t_ms: 700, zoom: 1.6, focal_x: 0.5, focal_y: 0.5, ease: "cubic_in_out" },
      { out_t_ms: 1300, zoom: 1.6, focal_x: 0.5, focal_y: 0.5, ease: "cubic_in_out" },
      { out_t_ms: FIXTURE_DURATION_MS, zoom: 1, focal_x: 0.5, focal_y: 0.5, ease: "cubic_in_out" },
    ],
  };
  await fs.writeFile(path.join(root, "edit-plan.json"), JSON.stringify(editPlan, null, 2));

  // 5. Stamp the bundle manifest. Hashes are computed from the files we
  //    just wrote so the bundle is round-trippable + verifiable.
  await writeBundleManifest({
    bundleRoot: root,
    recordingId,
    source: "cli",
    captureBackend: "playwright",
    producer: { name: "openslate-fixture", version: "0.0.0" },
    title: opts.title ?? "openSlate fixture",
    notes: "Synthetic 2-second recording for testing and demos.",
    target: {
      label: "fixture://sample",
      viewport: { width: FIXTURE_W, height: FIXTURE_H },
      device_pixel_ratio: 1,
      fps: FIXTURE_FPS,
    },
  });

  return root;
}
