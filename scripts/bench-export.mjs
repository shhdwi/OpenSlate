// Benchmark the export pipeline end-to-end, broken down by phase.
// Uses the prepareRender + renderMedia split from compositor/render.ts
// to get per-phase timings.
//
// Run from the openslate repo root:
//   bun scripts/bench-export.mjs <recording_id>

import path from "node:path";
import fs from "node:fs/promises";

const recordingId = process.argv[2] ?? "ask-question-1778156680281";
const recordingDir = path.resolve("recordings", recordingId);

console.log(`benchmarking export of ${recordingId}`);
console.log(`(re-uses existing recording — measures bundle + render + encode only)\n`);

// ── Phase 0: dynamic imports ─────────────────────────────────────────
const t0 = Date.now();
const { prepareRender } = await import("../dist/compositor/index.js");
const { DEFAULT_POLISH_PROFILE, outputDurationMs } = await import("../dist/index.js");
const remotion = await import("@remotion/renderer");
const t_import = Date.now();
console.log(`  imports:                  ${String(t_import - t0).padStart(6)} ms`);

// ── Phase 1: read manifest ───────────────────────────────────────────
const manifest = JSON.parse(await fs.readFile(path.join(recordingDir, "manifest.json"), "utf8"));
const profile = DEFAULT_POLISH_PROFILE;
const t_manifest = Date.now();
console.log(`  manifest IO:              ${String(t_manifest - t_import).padStart(6)} ms`);

// ── Phase 2: prepareRender (bundle + sprite copy + edit plan) ────────
const prepared = await prepareRender({ manifest, recording_dir: recordingDir, profile });
const t_prepare = Date.now();
console.log(`  prepareRender (bundle):   ${String(t_prepare - t_manifest).padStart(6)} ms`);

// ── Phase 3: selectComposition ───────────────────────────────────────
const inputProps = {
  manifest,
  events: prepared.events,
  cursor_samples: prepared.cursor_samples,
  frames_url_prefix: prepared.frames_url_prefix,
  profile,
  edit_plan: prepared.edit_plan,
  transparent_bg: false,
};
const composition = await remotion.selectComposition({
  serveUrl: prepared.bundleLocation,
  id: "polish",
  inputProps,
});
const [width, height] = [1920, 1080];
const fps = 60;
const visibleMs = outputDurationMs(prepared.edit_plan.segments, prepared.edit_plan.playback_rate);
const totalMs = visibleMs + (profile.outro.duration_ms ?? 0);
composition.width = width;
composition.height = height;
composition.fps = fps;
composition.durationInFrames = Math.ceil((totalMs / 1000) * fps);
const t_select = Date.now();
console.log(`  selectComposition:        ${String(t_select - t_prepare).padStart(6)} ms`);
console.log(`    → ${composition.durationInFrames} frames at ${fps} fps = ${(totalMs / 1000).toFixed(1)}s output`);

// ── Phase 4: renderMedia (PNG frames + h264 encode) ──────────────────
const outputPath = path.resolve("demos", `bench-${Date.now()}.mp4`);
await fs.mkdir(path.dirname(outputPath), { recursive: true });

let frameRenderProgress = 0;
let lastProgressLog = Date.now();
// Match render.ts production defaults: JPEG q=92 for opaque, default
// x264 preset (medium), concurrency 100%. PNG only when transparent_bg.
await remotion.renderMedia({
  composition,
  serveUrl: prepared.bundleLocation,
  codec: "h264",
  outputLocation: outputPath,
  inputProps,
  imageFormat: "jpeg",
  jpegQuality: 92,
  crf: 14,
  concurrency: "100%",
  chromiumOptions: { disableWebSecurity: true },
  onProgress: (p) => {
    frameRenderProgress = p.renderedFrames;
    const now = Date.now();
    if (now - lastProgressLog > 5000) {
      const pct = ((p.renderedFrames / composition.durationInFrames) * 100).toFixed(0);
      console.log(`    rendered ${p.renderedFrames}/${composition.durationInFrames} (${pct}%)`);
      lastProgressLog = now;
    }
  },
});
const t_render = Date.now();
console.log(`  renderMedia total:        ${String(t_render - t_select).padStart(6)} ms`);

const stat = await fs.stat(outputPath);
console.log(`\n  output: ${path.relative(process.cwd(), outputPath)} · ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
console.log(`\nTOTAL:                      ${String(t_render - t0).padStart(6)} ms`);
console.log(`  ≈ ${((t_render - t0) / 1000).toFixed(1)}s for ${composition.durationInFrames} output frames at ${fps}fps`);
console.log(`  ≈ ${((t_render - t0) / composition.durationInFrames).toFixed(0)}ms per output frame`);
