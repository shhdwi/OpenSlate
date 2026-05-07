/**
 * Headless Remotion render orchestrator.
 *
 * Two-tier API:
 *
 *   - renderPolished(opts)
 *       Single export. Bundles the Remotion entry, renders frames, and
 *       encodes to mp4 / webm / mov / gif. Optionally accepts a
 *       pre-built `prepared` package so callers running multiple
 *       exports can avoid re-bundling.
 *
 *   - prepareRender(opts)
 *       Builds the shared work that all exports of the same recording
 *       reuse: webpack bundle, edit-plan, events, cursor sprites copy.
 *       Pass the result into renderPolished({prepared}) for each
 *       export to skip ~12s of webpack per call.
 *
 *   - renderPolishedMany(opts)
 *       Convenience: prepares once, runs N renderPolished calls
 *       sequentially. The right surface for "give me default mp4 +
 *       transparent webm + social_vertical mp4 from this recording"
 *       workflows.
 *
 * Quality defaults — calibrated for the openSlate use case
 * (text-heavy product demos, viewed on web/mobile/landing pages):
 *   - imageFormat: "png" always (lossless source frames; no JPEG
 *     artifacts on UI text).
 *   - crf: 14 for h264 (visually-lossless+ threshold; was 18).
 *   - x264Preset: "slow" (better compression at same crf; ~2x encode
 *     time vs "medium" but ~25% smaller files at identical quality).
 *   - concurrency: "100%" (use all logical cores for frame render).
 *
 * VP8 alpha-webm speed — libvpx VP8 single-pass with default flags is
 * glacially slow (~30+ min for a 22s recording). We override with
 *   -cpu-used 4 -deadline good -threads 4
 * which preserves alpha-correctness while bringing encode time down to
 * ~3-5 minutes. The compression efficiency cost is small (~5-10% larger
 * files at the same visual quality) — fair trade for usable wall-clock.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ExportPreset, PolishProfile } from "../core/types.js";
import type { CursorSample, RecordedEvent, RecordingManifest } from "../recorder/events.js";
import { buildEditPlan, outputDurationMs, type EditPlan } from "../plan/edit-plan.js";

export interface RenderOptions {
  manifest: RecordingManifest;
  recording_dir: string;
  profile: PolishProfile;
  output_path: string;
  preset: ExportPreset;
  /** Optional reusable bundle + plan from prepareRender(). When present,
   * renderPolished skips the bundling phase (~12s saved per call). */
  prepared?: PreparedRender;
}

export interface RenderResult {
  output_path: string;
  size_bytes: number;
  duration_ms: number;
  dimensions: [number, number];
}

export interface PrepareOptions {
  manifest: RecordingManifest;
  recording_dir: string;
  profile: PolishProfile;
}

/**
 * Reusable pre-render package. Cheap to keep around; safe to share
 * across multiple renderPolished calls for the same recording.
 */
export interface PreparedRender {
  bundleLocation: string;
  events: RecordedEvent[];
  cursor_samples: CursorSample[];
  edit_plan: EditPlan;
  /** Resolved frames URL prefix relative to bundle root. */
  frames_url_prefix: string;
}

/**
 * Bundle the Remotion entry + load events / edit plan + copy cursor
 * sprites into the recording dir's publicDir. Returns a package suitable
 * for passing into one or many renderPolished calls.
 */
export async function prepareRender(opts: PrepareOptions): Promise<PreparedRender> {
  const { bundle } = await import("@remotion/bundler");

  const dirname = import.meta.dirname ?? __dirname;
  const entryCandidates: string[] = [
    path.resolve(dirname, "./remotion-entry.js"),
    path.resolve(dirname, "./remotion-entry.cjs"),
    path.resolve(dirname, "./compositor/remotion-entry.js"),
    path.resolve(dirname, "./compositor/remotion-entry.cjs"),
    path.resolve(dirname, "../compositor/remotion-entry.js"),
    path.resolve(dirname, "../compositor/remotion-entry.cjs"),
    ...walkUpToOpenSlate(dirname),
    path.resolve(dirname, "./remotion-entry.tsx"),
    path.resolve(dirname, "../../dist/compositor/remotion-entry.js"),
    path.resolve(dirname, "../../src/compositor/remotion-entry.tsx"),
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
      `openSlate: Remotion entry not found. Looked in:\n${entryCandidates
        .map((c) => `  - ${c}`)
        .join("\n")}\nRun \`bun run build\` or invoke from a built install.`,
    );
  }

  const events = await readJson<RecordedEvent[]>(
    path.join(opts.recording_dir, opts.manifest.events_file),
  );
  const cursor_samples = await readJson<CursorSample[]>(
    path.join(opts.recording_dir, opts.manifest.cursor_file),
  );

  // Cursor sprites: copy into the publicDir so the composition's
  // staticFile("cursors/<kind>.svg") resolves at the bundle origin.
  const spritesSrcCandidates = [
    path.resolve(path.dirname(entryPath), "./cursor-sprites"),
    path.resolve(path.dirname(entryPath), "../compositor/cursor-sprites"),
    path.resolve(dirname, "../../src/compositor/cursor-sprites"),
    path.resolve(dirname, "./cursor-sprites"),
  ];
  let spritesSrc: string | null = null;
  for (const c of spritesSrcCandidates) {
    if (await fileExists(c)) {
      spritesSrc = c;
      break;
    }
  }
  if (spritesSrc) {
    const cursorsDir = path.join(opts.recording_dir, "cursors");
    await fs.mkdir(cursorsDir, { recursive: true });
    for (const f of await fs.readdir(spritesSrc)) {
      if (!f.endsWith(".svg")) continue;
      await fs.copyFile(path.join(spritesSrc, f), path.join(cursorsDir, f));
    }
  }

  const frames_url_prefix = opts.manifest.frames_dir;

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

  // ── Edit plan: read from disk if persisted, else build inline ──────────
  const editPlanFile = path.join(opts.recording_dir, "edit-plan.json");
  let edit_plan: EditPlan;
  if (await fileExists(editPlanFile)) {
    edit_plan = await readJson<EditPlan>(editPlanFile);
  } else {
    edit_plan = buildEditPlan({
      recording_id: opts.manifest.id,
      manifest: opts.manifest,
      events,
      profile: opts.profile,
    });
    await fs.writeFile(editPlanFile, JSON.stringify(edit_plan, null, 2));
  }

  return { bundleLocation, events, cursor_samples, edit_plan, frames_url_prefix };
}

export async function renderPolished(opts: RenderOptions): Promise<RenderResult> {
  const { renderMedia, selectComposition } = await import("@remotion/renderer");

  const prepared =
    opts.prepared ??
    (await prepareRender({
      manifest: opts.manifest,
      recording_dir: opts.recording_dir,
      profile: opts.profile,
    }));

  const inputProps = {
    manifest: opts.manifest,
    events: prepared.events,
    cursor_samples: prepared.cursor_samples,
    frames_url_prefix: prepared.frames_url_prefix,
    profile: opts.profile,
    edit_plan: prepared.edit_plan,
    transparent_bg: opts.preset.transparent_bg === true,
  };

  const compositionId = "polish";
  const [width, height] = opts.preset.dimensions;
  const fps = opts.preset.fps ?? opts.manifest.fps;
  const visibleRecordingMs = outputDurationMs(
    prepared.edit_plan.segments,
    prepared.edit_plan.playback_rate,
  );
  const fullDurationMs = visibleRecordingMs + (opts.profile.outro.duration_ms ?? 0);
  const totalDurationMs =
    opts.preset.duration_max_s != null
      ? Math.min(fullDurationMs, opts.preset.duration_max_s * 1000)
      : fullDurationMs;
  const durationInFrames = Math.ceil((totalDurationMs / 1000) * fps);

  const composition = await selectComposition({
    serveUrl: prepared.bundleLocation,
    id: compositionId,
    inputProps,
  });
  composition.width = width;
  composition.height = height;
  composition.fps = fps;
  composition.durationInFrames = durationInFrames;

  await fs.mkdir(path.dirname(opts.output_path), { recursive: true });

  const isGif = opts.preset.format === "gif";
  const renderPath = isGif
    ? opts.output_path.replace(/\.gif$/i, ".__gif_intermediate.mp4")
    : opts.output_path;

  // Codec selection — see file header for context.
  type CodecChoice = "h264" | "vp8" | "prores";
  let codec: CodecChoice = "h264";
  let pixelFormat: "yuv420p" | "yuva420p" | undefined;
  if (isGif) {
    codec = "h264";
  } else if (opts.preset.format === "webm") {
    codec = "vp8";
    if (opts.preset.transparent_bg) pixelFormat = "yuva420p";
  } else if (opts.preset.format === "mov") {
    codec = "prores";
  } else {
    codec = "h264";
  }

  // Quality: PNG source frames in all paths (lossless input → encoder;
  // eliminates JPEG artifacts on UI text). Required when transparent.
  const imageFormat = "png";

  // VP8 speed override: libvpx with default flags takes 30+ minutes
  // for a 22s recording. -cpu-used 4 -deadline good -threads 4 brings
  // it down to a few minutes with negligible visible quality cost.
  // For h264, x264Preset:"slow" gives better compression at the same
  // crf — slower encode but smaller files at higher visual quality.
  const ffmpegOverride =
    codec === "vp8"
      ? (info: { args: string[] }) => injectAfterCodec(info.args, "libvpx", [
          "-cpu-used", "4",
          "-deadline", "good",
          "-threads", "4",
        ])
      : undefined;

  await renderMedia({
    composition,
    serveUrl: prepared.bundleLocation,
    codec,
    ...(pixelFormat ? { pixelFormat } : {}),
    outputLocation: renderPath,
    inputProps,
    imageFormat,
    // crf 14 for h264 = visually-lossless+. crf 18 (the previous
    // default) is "visually decent" but gradients band on dark UI.
    // For VP8 we leave Remotion's default crf (better quality than
    // we'd dial manually for alpha content).
    crf: codec === "h264" ? 14 : undefined,
    // x264 preset "slow" gives ~25% smaller files at identical quality
    // vs "medium" — worth ~2x encode time on h264 only.
    x264Preset: codec === "h264" ? "slow" : undefined,
    // Use all logical cores for the parallel frame render. "auto" is
    // Remotion's default but doesn't always saturate cores on macOS.
    concurrency: "100%",
    ffmpegOverride,
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

export interface RenderManyOptions {
  manifest: RecordingManifest;
  recording_dir: string;
  profile: PolishProfile;
  exports: ReadonlyArray<{ output_path: string; preset: ExportPreset }>;
}

/**
 * Run multiple exports of the same recording with a single bundle pass.
 * Each export gets its own preset (codec, dimensions, transparency,
 * etc.), but they all share the webpack bundle, edit plan, and cursor
 * sprite copy. For 4 exports this saves ~36s of bundling time.
 */
export async function renderPolishedMany(
  opts: RenderManyOptions,
): Promise<RenderResult[]> {
  const prepared = await prepareRender({
    manifest: opts.manifest,
    recording_dir: opts.recording_dir,
    profile: opts.profile,
  });
  const results: RenderResult[] = [];
  for (const e of opts.exports) {
    results.push(
      await renderPolished({
        manifest: opts.manifest,
        recording_dir: opts.recording_dir,
        profile: opts.profile,
        output_path: e.output_path,
        preset: e.preset,
        prepared,
      }),
    );
  }
  return results;
}

/**
 * Inject extra ffmpeg flags right after a `-c:v <codec>` pair in the
 * stitcher arg list, so they apply to the encoder. Returns the
 * unchanged args if the codec marker isn't found (Remotion shouldn't
 * change the arg shape, but be defensive).
 */
function injectAfterCodec(args: string[], codec: string, extra: string[]): string[] {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-c:v" && args[i + 1] === codec) {
      return [...args.slice(0, i + 2), ...extra, ...args.slice(i + 2)];
    }
  }
  return args;
}

/**
 * Two-pass GIF encoding tuned for max quality:
 *  - palettegen with stats_mode=full analyzes every frame
 *  - paletteuse with floyd_steinberg dither (better fidelity than bayer,
 *    minimal file-size penalty in practice)
 *  - lanczos scaling preserves text legibility on downscale
 */
async function convertMp4ToGif(
  src: string,
  dst: string,
  opts: { fps: number; width: number; height: number },
): Promise<void> {
  const palettePath = `${src}.palette.png`;
  const filtersPaletteGen = `fps=${opts.fps},scale=${opts.width}:${opts.height}:flags=lanczos,palettegen=stats_mode=full`;
  const filtersUse = `fps=${opts.fps},scale=${opts.width}:${opts.height}:flags=lanczos[v];[v][1:v]paletteuse=dither=floyd_steinberg`;

  await runFfmpeg(["-y", "-i", src, "-vf", filtersPaletteGen, palettePath]);
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

/**
 * Walk up from `start` looking for `node_modules/openslate/dist/compositor/
 * remotion-entry.{js,cjs}` (the bundled entry shipped with the npm package).
 */
function walkUpToOpenSlate(start: string): string[] {
  const candidates: string[] = [];
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    candidates.push(
      path.join(parent, "node_modules/openslate/dist/compositor/remotion-entry.js"),
      path.join(parent, "node_modules/openslate/dist/compositor/remotion-entry.cjs"),
    );
    dir = parent;
  }
  return candidates;
}

async function readJson<T>(p: string): Promise<T> {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as T;
}

// Re-exported for testing.
export { injectAfterCodec };
