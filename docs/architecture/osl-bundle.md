# `.osl` — the openSlate Project Bundle

A self-contained, schema-versioned, surface-agnostic directory that any
openSlate surface (MCP/CLI, Mac app, webapp) can produce or consume. The
bundle is the contract that lets a project move freely between surfaces:
capture it from the MCP, edit it in the Mac app, export it from the webapp.

If the bundle can't round-trip across surfaces, the "no platform constraint"
guarantee is broken. The Zod schema + the round-trip test suite in
`tests/osl.test.ts` are the gates.

## Layout

```
my-demo.osl/
├── osl-bundle.json          # manifest of manifests — schema version + inventory
├── manifest.json            # recording metadata (viewport, fps, duration, frame indices)
├── events.json              # structured action log (click/type/scroll/nav/highlight)
├── cursor.json              # cursor trajectory samples (~125 Hz)
├── edit-plan.json           # deterministic camera + audio score
├── polish.config.json       # optional: JSON twin of polish.config.ts
├── raw/                     # optional: native captures
│   ├── capture.mp4          #   cursor-hidden source video (Mac/web paths)
│   ├── mic.wav              #   mic track
│   └── system.wav           #   system audio track
├── frames/                  # optional: PNG sequence (Playwright path)
│   └── frame_NNNNNN.png
└── thumbnails/              # optional: timeline scrubber thumbnails
    └── NNNN.jpg
```

The bundle manifest declares which of the optional artifacts are present.
Consumers branch on the inventory: a Playwright-captured bundle uses
`frames/`, a ScreenCaptureKit-captured bundle uses `raw/capture.mp4`. The
edit-plan + cursor.json layers are identical across paths — that's the
whole point.

## `osl-bundle.json`

The bundle manifest is the only file every surface must read and write.
Schema lives in `src/osl/schema.ts` (Zod) and `src/osl/types.ts`
(TypeScript). Current version: `1.0`.

Key fields:

- `schema_version` — bumped only on breaking changes. Migrations land in
  `src/osl/migrate.ts`.
- `bundle_id` — stable UUID. Preserved across re-writes so external
  references (e.g. analytics, comments, links) stay valid.
- `source` — `"mcp" | "cli" | "mac_app" | "webapp" | "imported"`.
- `capture_backend` — `"playwright" | "screencapturekit" | "wgc" |
  "getdisplaymedia"`.
- `artifacts` — sha256 + size for every JSON artifact present, plus
  directory refs for `frames_dir` / `thumbnails_dir`.
- `audio` — present when any audio track was captured; records sample
  rate, channels, codec, duration per track.
- `target` — sticky metadata that survives editing: URL or app label,
  viewport, device pixel ratio, fps.

## Why directory, not single-file?

The bundle is a directory in dev (easy to grep, edit, diff) and can be
zipped for transport. The reader (`src/osl/reader.ts`) accepts a
directory path. A future packing layer (`packBundle`/`unpackBundle`) will
zip + unzip the directory form. The JSON contract doesn't change.

## Reading + writing

```ts
import {
  buildFixture,
  isBundle,
  readBundle,
  readBundleManifest,
  writeBundleManifest,
} from "openslate/osl";

// Stamp an existing recording dir as a bundle:
await writeBundleManifest({
  bundleRoot: "./recordings/abc123",
  recordingId: "abc123",
  source: "cli",
  captureBackend: "playwright",
  producer: { name: "openslate", version: "0.0.1" },
  target: { label: "https://x.com", viewport: { width: 1280, height: 800 },
            device_pixel_ratio: 1, fps: 60 },
});

// Read a bundle (validates the manifest, resolves required JSON artifacts):
const bundle = await readBundle("./recordings/abc123");
//   bundle.manifest, bundle.recording_manifest, bundle.events,
//   bundle.cursor, bundle.edit_plan
```

## Round-trip guarantee

Every surface that writes a bundle must produce a manifest that Zod parses
without errors. Every surface that reads a bundle must call
`migrateBundleManifest()` before validation so older bundles keep working.

Re-writing a bundle preserves `bundle_id` and `created_at`. Only
`modified_at` advances. Re-write is the only legal mutation path —
direct edits to `osl-bundle.json` break sha256s in the artifact inventory.

## What's intentionally NOT in the bundle

- **Source assets that aren't reproducible from the capture** (custom
  flourish SVGs, webcam frames, sound effects) — those live in a separate
  `assets/` dir referenced from `polish.config.json`. Future work.
- **Rendered outputs** (`out.mp4`, `out.gif`) — those are derived
  artifacts and live alongside the bundle, not inside it.
- **Tool-specific UI state** (timeline zoom level, last-selected
  keyframe) — surfaces store this in their own local state, not in the
  bundle.

The bundle is the description of what the demo is. Surfaces decide how to
present that description.
