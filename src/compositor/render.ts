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
import { spawn } from "node:child_process";
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

  // Resolve the Remotion entry. In production (consumed via npm), we ship
  // dist/compositor/remotion-entry.js next to render.js. In dev (running
  // from src/ via bun), we fall back to the .tsx source — Remotion's bundler
  // accepts both. Final fallback: the dist build, if a previous `bun run
  // build` produced one.
  const dirname = import.meta.dirname ?? __dirname;
  const entryCandidates = [
    path.resolve(dirname, "./remotion-entry.js"),
    path.resolve(dirname, "./remotion-entry.tsx"),
    path.resolve(dirname, "../../dist/compositor/remotion-entry.js"),
  ];
  let entryPath: string | null = null;
  for (const candidate of entryCandidates) {
    if (await fileExists(candidate)) {
      entryPath = candidate;
      break;
    }
  }
  if (!entryPath) {
    throw new Error(
      `openSlate: Remotion entry not found. Looked in:\n${entryCandidates.map((c) => `  - ${c}`).join("\n")}\nRun \`bun run build\` or invoke from a built install.`,
    );
  }

  const events = await readJson<RecordedEvent[]>(
    path.join(opts.recording_dir, opts.manifest.events_file),
  );
  const cursor_samples = await readJson<CursorSample[]>(
    path.join(opts.recording_dir, opts.manifest.cursor_file),
  );

  // Frames live in opts.recording_dir/frames. We pass the recording dir as
  // Remotion's publicDir so the bundle serves frames at its own origin —
  // sidesteps Chromium's file:// scheme restrictions during render.
  // The composition consumes frames at `<frames_dir>/frame_NNNNNN.png`
  // (relative to bundle root) — i.e. `frames_url_prefix` is the relative
  // dir name within the served bundle.
  const frames_url_prefix = opts.manifest.frames_dir;

  // Bundle the Remotion entry. webpackOverride teaches webpack that `.js`
  // import specifiers may resolve to .tsx/.ts sources — needed when the
  // entry is the .tsx in src/ (TS-ESM convention requires .js suffixes).
  // publicDir copies the recording's frames into the bundle's static area
  // so the renderer can load them via http(s) (or file://) at bundle origin.
  const bundleLocation = await bundle({
    entryPoint: entryPath,
    publicDir: opts.recording_dir,
    webpackOverride: (cfg) => ({
      ...cfg,
      resolve: {
        ...cfg.resolve,
        extensionAlias: {
          ".js": [".tsx", ".ts", ".js"],
          ".jsx": [".tsx", ".jsx"],
        },
      },
    }),
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
  // Honor manifest.start_offset_ms — recorder-trimmed page-load period
  // is excluded from the visible output.
  const visibleRecordingMs =
    opts.manifest.duration_ms - (opts.manifest.start_offset_ms ?? 0);
  const fullDurationMs = visibleRecordingMs + (opts.profile.outro.duration_ms ?? 0);
  // Honor preset.duration_max_s — readme_hero gifs are capped at 6s, etc.
  const totalDurationMs =
    opts.preset.duration_max_s != null
      ? Math.min(fullDurationMs, opts.preset.duration_max_s * 1000)
      : fullDurationMs;
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

  // For GIF output we render to mp4 first (Remotion's gif codec is single-
  // pass and produces visible palette banding on gradients), then convert
  // via ffmpeg's two-pass palettegen + paletteuse pipeline. The result is
  // dramatically cleaner — proper dithering, no diagonal banding on
  // gradient backgrounds.
  const isGif = opts.preset.format === "gif";
  const renderPath = isGif
    ? opts.output_path.replace(/\.gif$/i, ".__gif_intermediate.mp4")
    : opts.output_path;

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: isGif ? "h264" : opts.preset.format === "webm" ? "vp8" : "h264",
    outputLocation: renderPath,
    inputProps,
    imageFormat: "jpeg",
    jpegQuality: 92,
    crf: 18,
    // Recording frames live at file:// paths; Chromium's default policy
    // blocks file:// loads from a non-file:// origin (the bundled serve URL).
    // Disable web security for the render pass only — Remotion launches a
    // dedicated headless instance, so this scope is safe.
    chromiumOptions: { disableWebSecurity: true },
  });

  if (isGif) {
    await convertMp4ToGif(renderPath, opts.output_path, {
      fps: opts.preset.fps ?? 24,
      width,
      height,
    });
    await fs.unlink(renderPath).catch(() => {});
  }

  const stat = await fs.stat(opts.output_path);
  return {
    output_path: opts.output_path,
    size_bytes: stat.size,
    duration_ms: totalDurationMs,
    dimensions: [width, height],
  };
}

/**
 * Two-pass GIF encoding: first pass generates an optimal 256-color palette
 * weighted by frame statistics; second pass uses that palette with Bayer
 * dithering to produce significantly cleaner output than ffmpeg's default
 * single-pass encoder (especially on gradient backgrounds, where single-pass
 * produces visible diagonal banding).
 */
async function convertMp4ToGif(
  src: string,
  dst: string,
  opts: { fps: number; width: number; height: number },
): Promise<void> {
  const palettePath = `${src}.palette.png`;
  const filtersPaletteGen = `fps=${opts.fps},scale=${opts.width}:${opts.height}:flags=lanczos,palettegen=stats_mode=full`;
  const filtersUse = `fps=${opts.fps},scale=${opts.width}:${opts.height}:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5`;

  await runFfmpeg([
    "-y",
    "-i",
    src,
    "-vf",
    filtersPaletteGen,
    palettePath,
  ]);

  await runFfmpeg([
    "-y",
    "-i",
    src,
    "-i",
    palettePath,
    "-filter_complex",
    filtersUse,
    "-loop",
    "0",
    dst,
  ]);

  await fs.unlink(palettePath).catch(() => {});
}

async function runFfmpeg(args: string[]): Promise<void> {
  const ffmpegBin = process.env.OPENSLATE_FFMPEG_PATH || "ffmpeg";
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrBuf = "";
    proc.stderr.on("data", (d) => {
      stderrBuf += d.toString();
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderrBuf.slice(-1000)}`));
    });
  });
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
