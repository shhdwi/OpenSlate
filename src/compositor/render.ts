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
 * Defaults are tuned for "works on anyone's machine" rather than
 * "fastest on my M-series Mac." Specifically: we never override
 * Remotion's RAM/CPU auto-detection, so a 4-core 8GB Linux laptop
 * picks ~2 workers and a 16-core 64GB workstation picks ~8 — the
 * package adapts.
 *
 *   - imageFormat: "jpeg" q=92 for opaque, "png" for transparent_bg.
 *     JPEG cuts ~12% off render time on bench machines; visual diff
 *     is imperceptible (the source frames from CDP screencast are
 *     already JPEG-grade). PNG required when alpha is needed.
 *   - crf: 14 for h264 (visually-lossless+).
 *   - x264 preset: Remotion's default (medium).
 *   - concurrency: Remotion's default (auto). DO NOT force "100%" —
 *     each Chromium worker takes ~700MB; forcing all cores OOMs
 *     low-RAM machines.
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

  // Image format: JPEG q=92 for opaque exports, PNG for transparent.
  //
  // Bench data (1920×1080, 13s output = 792 frames, M-series Mac):
  //   - PNG everywhere:    ~96 ms / frame ≈ 76 s render (the previous
  //                        default — bumped to PNG for "highest quality"
  //                        but the per-frame cost dominated everything)
  //   - JPEG q=92 opaque:  ~38 ms / frame ≈ 30 s render (~2.5× faster)
  //
  // Visual quality difference between PNG and JPEG q=92 for video frames
  // is imperceptible on the demo content (UI text, gradients, screen
  // captures). The recording's source frames are themselves JPEG-quality
  // PNGs from CDP screencast, so a true lossless render-stage doesn't
  // recover information that's already been lost upstream. Use PNG only
  // when the export NEEDS alpha (which JPEG can't carry).
  const transparentRender = opts.preset.transparent_bg === true;
  const imageFormat = transparentRender ? "png" : "jpeg";

  // VP8 speed override (transparent webm only): libvpx with default
  // flags takes 30+ minutes; -cpu-used 4 -deadline good -threads 4
  // brings it down to a few minutes with negligible visible quality cost.
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
    jpegQuality: 92,
    // h264 crf 14 = visually-lossless+. For VP8 we leave Remotion's
    // default crf (better tuned for alpha content than we'd dial here).
    crf: codec === "h264" ? 14 : undefined,
    // x264 preset omitted → Remotion's default ("medium"). Slow halves
    // encode time per frame for ~25% smaller files; the trade is
    // wasteful when the render is 30s anyway. Re-enable via
    // `x264Preset` if you need smaller files.
    //
    // concurrency omitted → Remotion's auto-detect picks a safe value
    // based on available RAM and CPU cores. We don't force "100%"
    // because each Chromium worker takes ~700 MB; on a 4-core 8 GB
    // machine, "100%" = 4 workers = ~2.8 GB just for rendering, which
    // OOMs the system. Auto adapts: ~2 workers on low-RAM laptops, up
    // to 8 on a 16-core workstation.
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
