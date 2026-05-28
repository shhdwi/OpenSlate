# Dual-renderer architecture

openSlate ships two compositors that read the same `.osl` bundle:

- **Remotion** (`src/compositor/`) — offline, frame-by-frame, cacheable,
  hardware-encoded. This is the export path. Used by the CLI export
  command and the MCP `record_export` tool, and by the Mac app + webapp
  for the final render.
- **PixiJS** (`src/preview/`) — live, interactive, 60fps. This is the
  editor path. The Mac app and webapp embed it for timeline scrubbing
  and live preview.

The dual-renderer model lets us hit two contradictory requirements:

1. The polish pipeline stays on Remotion — deterministic, frame-cacheable,
   the polish moat. The MCP/CLI export path is unchanged.
2. The editor UX matches what Screen Studio class apps offer — drag a
   zoom keyframe and the preview updates next frame.

## The parity contract

Both renderers consume the same `edit-plan.json` and the same camera math
in `src/compositor/camera.ts`. There is no second camera implementation.
The shared module exports:

- `sampleCamera(keyframes, t_ms): CameraState` — interpolation between
  keyframes using `ease` curves. Used by Remotion and PixiJS to compute
  zoom + focal point at any output time.
- `cameraTransform(state, viewport): { scale, translate_x, translate_y }`
  — the concrete pixel transform applied to the recording layer.
- `outToSrc(out_t_ms, segments, rate)` — output-time → source-time
  mapping. Both renderers use it to pick which source frame / cursor
  sample to display at the current output time.

If a layer's preview output drifts from its export output above an SSIM
threshold, that's a parity bug. The parity test (`tests/camera-parity.test.ts`)
locks the camera math. Future per-layer parity tests will lock the rest.

## What lives where

| Layer                | Remotion (export)            | PixiJS (preview)             | Shared math                |
|----------------------|------------------------------|------------------------------|----------------------------|
| Background           | `compositor/background.tsx`  | (TODO) `preview/layers/bg`   | `core/types` colors        |
| Frame chrome         | `compositor/frame.tsx`       | (TODO) `preview/layers/frame`| (none — pure CSS/SVG)      |
| Recording playback   | `compositor/composition.tsx` | `preview/engine.ts`          | `compositor/camera.ts` ✓   |
| Cursor overlay       | `compositor/cursor.tsx`      | (TODO) `preview/layers/cursor`| `utils/springs.ts`         |
| Click effects        | `flourishes/click-highlight` | (TODO)                       | (TODO — pull from events)  |
| Captions             | `compositor/captions.tsx`    | (TODO)                       | (TODO)                     |
| Flourishes           | `flourishes/index.ts`        | (TODO)                       | (TODO)                     |

The recording-playback layer is the proof-of-concept. The other six
layers will land iteratively, each behind the parity gate.

## How parity stays locked

Three discipline rules:

1. **No second implementation of any compositor primitive.** If Remotion
   needs `sampleCamera`, it imports from `compositor/camera.ts`. If
   PixiJS needs it, same module. Re-deriving math locally is the bug.
2. **`.osl` is the only input.** Both renderers take a bundle + an output
   time. They don't read separate config files at render time.
3. **Tests enforce it.** `tests/camera-parity.test.ts` runs a brute-force
   reference against the shipping function at 1000 random times. Future
   per-layer parity tests do pixel-diff between PixiJS-rendered frames
   and Remotion-rendered frames at known times.

## Why not a single renderer

We considered going all-PixiJS or all-Remotion:

- **All-PixiJS**: would lose Remotion's offline cache, deterministic
  hashing, and hardware encoding. Polish moat shrinks.
- **All-Remotion**: would lose the interactive editor. Users expect
  Screen Studio class scrubbing; Remotion can't do that in real time.

So both ship. The shared `.osl` bundle + shared camera math means the
maintenance cost is bounded: there are only two kinds of code, polished
math (shared) and presentation primitives (renderer-specific).

## Surfaces that consume each

- **MCP / CLI**: Remotion only. Export `record_export` → mp4.
- **Mac app**: PixiJS (preview) + Remotion (export). Embeds both.
- **Webapp**: PixiJS (preview) + Remotion (export, runs on a separate
  render worker since Vercel Edge can't host FFmpeg).
