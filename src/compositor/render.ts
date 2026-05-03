/**
 * Headless Remotion render orchestrator. Bundles the composition entry,
 * resolves the recording's frame sequence + events, and renders to mp4 / gif.
 *
 * Two paths in v1:
 *   - mp4 / webm: bundleAndRender via Remotion's renderMedia
 *   - gif: render frames then ffmpeg post (Remotion's gif support exists but
 *          quality is finicky; v1 uses ffmpeg directly for cleaner results)
 *
 * v1 ships with a built-in entry that registers <Composition> for our
 * PolishComposition. Users don't write Remotion entries; openSlate does.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ExportPreset, PolishProfile } from "../core/types.js";
import type { CursorSample, RecordedEvent, RecordingManifest } from "../recorder/events.js";

export interface RenderOptions {
  manifest: RecordingManifest;
  recording_dir: string;
  profile: PolishProfile;
  output_path: string;
  preset: ExportPreset;
}

export interface RenderResult {
  output_path: string;
  size_bytes: number;
  duration_ms: number;
  dimensions: [number, number];
}

export async function renderPolished(opts: RenderOptions): Promise<RenderResult> {
  // We dynamically import @remotion/bundler and @remotion/renderer so that
  // installations that only consume the types (e.g. the SKILL.md surface in
  // tests) don't pay the heavy Chromium cost on every import.
  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition } = await import("@remotion/renderer");

  const entryPath = path.resolve(import.meta.dirname ?? __dirname, "./remotion-entry.js");
  // Verify the bundled entry exists in dist/. If running from src/, the
  // tsup build outputs entry to dist/compositor/remotion-entry.js.
  const entryExists = await fileExists(entryPath);
  if (!entryExists) {
    throw new Error(
      `openSlate: Remotion entry not found at ${entryPath}. Run \`bun run build\` first.`,
    );
  }

  const events = await readJson<RecordedEvent[]>(
    path.join(opts.recording_dir, opts.manifest.events_file),
  );
  const cursor_samples = await readJson<CursorSample[]>(
    path.join(opts.recording_dir, opts.manifest.cursor_file),
  );

  const framesAbs = path.join(opts.recording_dir, opts.manifest.frames_dir);
  const frames_url_prefix = pathToFileURL(framesAbs).toString();

  // Bundle the Remotion entry.
  const bundleLocation = await bundle({
    entryPoint: entryPath,
    webpackOverride: (cfg) => cfg,
  });

  const inputProps = {
    manifest: opts.manifest,
    events,
    cursor_samples,
    frames_url_prefix,
    profile: opts.profile,
  };

  const compositionId = "polish";
  const [width, height] = opts.preset.dimensions;
  const fps = opts.preset.fps ?? opts.manifest.fps;
  const totalDurationMs = opts.manifest.duration_ms + (opts.profile.outro.duration_ms ?? 0);
  const durationInFrames = Math.ceil((totalDurationMs / 1000) * fps);

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: compositionId,
    inputProps,
  });

  // Override the composition's reported dimensions with the export preset.
  composition.width = width;
  composition.height = height;
  composition.fps = fps;
  composition.durationInFrames = durationInFrames;

  await fs.mkdir(path.dirname(opts.output_path), { recursive: true });

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: opts.preset.format === "gif" ? "gif" : opts.preset.format === "webm" ? "vp8" : "h264",
    outputLocation: opts.output_path,
    inputProps,
    imageFormat: "jpeg",
    jpegQuality: 92,
    crf: opts.preset.format === "gif" ? undefined : 18,
  });

  const stat = await fs.stat(opts.output_path);
  return {
    output_path: opts.output_path,
    size_bytes: stat.size,
    duration_ms: totalDurationMs,
    dimensions: [width, height],
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(p: string): Promise<T> {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as T;
}
