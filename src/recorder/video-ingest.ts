/**
 * Ingest a pre-existing video file (webm / mp4) into the openSlate
 * recording format. Used by the web-recorder path: the browser captures
 * the user's screen via getDisplayMedia and uploads the resulting blob;
 * we extract its frames and synthesize the manifest + events the
 * downstream pipeline expects.
 *
 * Output is identical-shaped to a Playwright recording so buildEditPlan
 * + renderPolished consume it without modification.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { RecordedEvent, RecordingManifest } from "./events.js";

export interface IngestVideoOptions {
  /** Absolute path to the source video file (webm/mp4). */
  video_path: string;
  /** Where to write recordings/<id>/. */
  recording_dir: string;
  /** Recording id; matches the directory name (e.g. "web-2026-05-10-..."). */
  recording_id: string;
  /** Output frame rate. The pipeline assumes 60; lower-fps captures get
   *  upsampled by ffmpeg's frame interpolation (-fps_mode cfr). */
  fps?: number;
}

export interface IngestVideoResult {
  manifest: RecordingManifest;
  frame_count: number;
  duration_ms: number;
  viewport: { width: number; height: number };
}

/**
 * Probe a video file with ffprobe → { width, height, duration_ms, fps }.
 * Returns null if probing fails (caller should error with a clear message).
 */
async function probe(
  video_path: string,
): Promise<{ width: number; height: number; duration_ms: number; src_fps: number } | null> {
  const proc = spawn("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate:format=duration",
    "-of", "json",
    video_path,
  ]);
  let out = "";
  proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  const code = await new Promise<number>((resolve) => proc.on("close", resolve));
  if (code !== 0) return null;
  try {
    const j = JSON.parse(out);
    const stream = j.streams?.[0];
    const format = j.format;
    if (!stream || !format) return null;
    // r_frame_rate is "60/1" or "30000/1001" etc.
    const parts = String(stream.r_frame_rate).split("/").map(Number);
    const num = parts[0] ?? 30;
    const den = parts[1] ?? 1;
    const src_fps = den ? num / den : 30;
    return {
      width: Number(stream.width),
      height: Number(stream.height),
      duration_ms: Math.round(Number(format.duration) * 1000),
      src_fps,
    };
  } catch {
    return null;
  }
}

/**
 * Extract every frame from `video_path` into `frames_dir/frame_NNNNNN.png`
 * at `fps`. The naming matches what the Playwright recorder produces.
 */
async function extractFrames(
  video_path: string,
  frames_dir: string,
  fps: number,
): Promise<void> {
  await fs.mkdir(frames_dir, { recursive: true });
  // -fps_mode cfr forces a constant output frame rate; ffmpeg interpolates
  // or drops frames as needed. -start_number 0 matches the recorder's
  // 0-indexed naming. PNG output (lossless) so the polish pipeline gets
  // the highest-quality source frames; cost is bounded by the recording
  // length and is paid once at ingest.
  const args = [
    "-y",
    "-i", video_path,
    "-fps_mode", "cfr",
    "-r", String(fps),
    "-start_number", "0",
    path.join(frames_dir, "frame_%06d.png"),
  ];
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const code = await new Promise<number>((resolve) => proc.on("close", resolve));
  if (code !== 0) {
    throw new Error(`ffmpeg frame extraction failed (exit ${code}):\n${stderr.slice(-1000)}`);
  }
}

/**
 * Ingest a video file: extract frames, write manifest + minimal
 * events.json + empty cursor.json. Returns the manifest so the caller
 * can hand it directly to renderPolished.
 *
 * Events: we synthesize a single `frame_start` at t=0 plus a
 * `frame_end` at the video's duration. No clicks / cursor moves —
 * those need a separate cursor-tracking pass (template matching from
 * the captured frames; future Tier 1.5 work).
 */
export async function ingestVideo(opts: IngestVideoOptions): Promise<IngestVideoResult> {
  const fps = opts.fps ?? 60;
  const probed = await probe(opts.video_path);
  if (!probed) {
    throw new Error(
      `Could not probe video at ${opts.video_path}. Is ffprobe installed?`,
    );
  }

  const frames_dir = path.join(opts.recording_dir, "frames");
  await extractFrames(opts.video_path, frames_dir, fps);

  // Sorted list of frame indices that actually landed on disk.
  const frame_files = (await fs.readdir(frames_dir))
    .filter((f) => /^frame_\d+\.png$/.test(f))
    .sort();
  const frame_indices = frame_files.map((f) => {
    const m = f.match(/^frame_(\d+)\.png$/);
    return m ? Number.parseInt(m[1]!, 10) : 0;
  });
  const frame_count = frame_indices.length;
  const duration_ms = Math.round((frame_count / fps) * 1000);

  // CFR ingest → frame timestamps are evenly spaced at 1000/fps ms.
  const frame_timestamps_ms = frame_indices.map((i) => Math.round((i / fps) * 1000));

  // Minimal events: one synthetic frame_start at t=0. The edit-plan
  // builder treats this as a navigate marker; with no salient events
  // (clicks/types) the builder produces a single segment covering the
  // whole video, which is exactly what we want for a passive ingest.
  const events: RecordedEvent[] = [
    { kind: "frame_start", t_ms: 0 },
  ];

  // Stub manifest. base_url is "web-record" since there's no URL —
  // useful as a debug breadcrumb, ignored by downstream code.
  const manifest: RecordingManifest = {
    id: opts.recording_id,
    created_at: new Date().toISOString(),
    duration_ms,
    fps,
    viewport: { width: probed.width, height: probed.height },
    device_pixel_ratio: 1, // captured stream is already in screen pixels
    frame_count,
    frame_indices,
    frame_timestamps_ms,
    start_offset_ms: 0,
    frames_dir: "frames",
    events_file: "events.json",
    cursor_file: "cursor.json",
    plan_file: "plan.json",
    base_url: "web-record",
  };

  await fs.writeFile(
    path.join(opts.recording_dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await fs.writeFile(
    path.join(opts.recording_dir, "events.json"),
    JSON.stringify(events, null, 2),
  );
  // Empty cursor stream — the compositor handles "no cursor data" by
  // not rendering the cursor sprite at all (the user's system cursor
  // is baked into the captured frames anyway).
  await fs.writeFile(path.join(opts.recording_dir, "cursor.json"), "[]");
  // Stub plan.json so consumers that expect a plan file don't error.
  await fs.writeFile(
    path.join(opts.recording_dir, "plan.json"),
    JSON.stringify({ id: opts.recording_id, source: "web-record" }, null, 2),
  );

  return {
    manifest,
    frame_count,
    duration_ms,
    viewport: manifest.viewport,
  };
}
