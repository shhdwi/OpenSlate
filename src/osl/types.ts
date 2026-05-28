/**
 * .osl — the openSlate Project Bundle.
 *
 * A self-contained, schema-versioned, surface-agnostic directory that any
 * openSlate surface (MCP/CLI, Mac app, webapp) can produce or consume. The
 * bundle is the contract that lets a project move freely between surfaces:
 * capture it from the MCP, edit it in the Mac app, export it from the webapp.
 *
 * Layout (directory form — zip form is a future packaging convenience):
 *
 *   <project>.osl/
 *     osl-bundle.json          ← this file's schema (manifest of manifests)
 *     manifest.json            ← recording metadata (viewport, fps, duration)
 *     events.json              ← structured action log (click/type/scroll/nav)
 *     cursor.json              ← cursor trajectory samples (~125 Hz)
 *     edit-plan.json           ← deterministic camera + audio score
 *     polish.config.json       ← JSON twin of polish.config.ts
 *     raw/
 *       capture.mp4            ← cursor-hidden source video (when present)
 *       mic.wav                ← mic track (when captured)
 *       system.wav             ← system audio track (when captured)
 *     frames/
 *       frame_NNNNNN.png       ← PNG sequence (legacy + Playwright path)
 *     thumbnails/
 *       NNNN.jpg               ← timeline scrubber thumbnails (optional)
 *
 * The bundle manifest only carries metadata about WHICH parts are present
 * and HOW they should be interpreted. The heavy artifacts stay where they
 * always lived; we just declare them in one well-versioned place.
 */

export const OSL_SCHEMA_VERSION = "1.0";

/** Which surface produced this bundle. */
export type OslSource =
  | "mcp" // MCP server invoked by Claude Code / Cursor / Codex
  | "cli" // direct CLI invocation
  | "mac_app" // Electron Mac app
  | "webapp" // browser getDisplayMedia
  | "imported"; // round-trip from another tool

/** Which capture backend produced the frames + events. */
export type OslCaptureBackend =
  | "playwright" // headless Chromium (v1 default)
  | "screencapturekit" // macOS native via Swift helper
  | "wgc" // Windows Graphics Capture (future)
  | "getdisplaymedia"; // browser API

/** Optional artifact, declared in the manifest so consumers know what to look for. */
export interface OslArtifactRef {
  /** Path relative to the bundle root. */
  path: string;
  /** Best-effort size in bytes. Informational, not load-bearing. */
  size_bytes?: number;
  /** SHA-256 of the file contents. Lets readers detect tampering / drift. */
  sha256?: string;
}

/** Audio metadata when audio is present. Absent => no audio captured. */
export interface OslAudioInfo {
  /** Sample rate in Hz (typically 48000). */
  sample_rate: number;
  /** Channel layout. 1 = mono, 2 = stereo. */
  channels: 1 | 2;
  /** Codec the file is stored in. WAV is the lossless interchange default. */
  codec: "pcm_s16le" | "pcm_f32le" | "aac" | "opus";
  /** Duration in ms; should align with the recording window. */
  duration_ms: number;
}

/**
 * The bundle manifest — a single file (`osl-bundle.json`) at the root of
 * every .osl that declares schema version, source, and which artifacts
 * are actually present. Loaders use this to know what to expect.
 */
export interface OslBundleManifest {
  /** Semver-ish; bumped only when the bundle schema breaks. */
  schema_version: typeof OSL_SCHEMA_VERSION;
  /** Stable id for this bundle. Survives re-renders + re-imports. */
  bundle_id: string;
  /** Original recording id (matches manifest.json.recording_id). */
  recording_id: string;
  /** Which surface produced this bundle. */
  source: OslSource;
  /** Which capture backend produced the frames. */
  capture_backend: OslCaptureBackend;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 last-edited timestamp (updated on any plan/profile mutation). */
  modified_at: string;
  /** Title shown in editor UIs. Free text. */
  title?: string;
  /** Free-text notes — anything the producing surface wants to attach. */
  notes?: string;
  /** Tool versions for forensic reproducibility. */
  producer: {
    name: string; // "openslate-cli", "openslate-mac", "openslate-web"
    version: string; // package.json version
  };
  /** Inventory of artifacts present in this bundle. Required ones are
   *  always set; optional ones are absent when not captured. */
  artifacts: {
    manifest: OslArtifactRef;
    events: OslArtifactRef;
    cursor: OslArtifactRef;
    edit_plan: OslArtifactRef;
    polish_config?: OslArtifactRef;
    raw_capture?: OslArtifactRef;
    mic_audio?: OslArtifactRef;
    system_audio?: OslArtifactRef;
    frames_dir?: { path: string; count?: number };
    thumbnails_dir?: { path: string; count?: number };
  };
  /** Audio info, present when at least one audio track was captured. */
  audio?: {
    mic?: OslAudioInfo;
    system?: OslAudioInfo;
  };
  /** Sticky metadata about the recording target (URL, app name, viewport). */
  target: {
    /** What was recorded — URL for web captures, app name for native. */
    label: string;
    /** Captured viewport in pixels. */
    viewport: { width: number; height: number };
    /** Device pixel ratio at capture time. */
    device_pixel_ratio: number;
    /** Recording fps (typically 60). */
    fps: number;
  };
}

/**
 * The fully-hydrated bundle — every JSON artifact parsed and ready to feed
 * into the compositor / preview engine. Constructed by `readBundle()`.
 *
 * Heavy artifacts (mp4, wav, PNGs) are NOT loaded into memory here — they
 * stay on disk and the consumer pulls them when it needs to render. This
 * keeps `readBundle()` cheap even for hour-long projects.
 */
export interface OslBundle {
  /** Absolute path to the bundle root directory. */
  root: string;
  /** The parsed bundle manifest. */
  manifest: OslBundleManifest;
  /**
   * Parsed JSON artifacts. We use `unknown` here to avoid a circular
   * import on the existing types — concrete shapes are declared by their
   * owning modules (RecordingManifest, RecordedEvent[], CursorSample[],
   * EditPlan, PolishProfile). Use the typed reader in `./reader.ts` to
   * get them cast.
   */
  recording_manifest: unknown;
  events: unknown;
  cursor: unknown;
  edit_plan: unknown;
  polish_config?: unknown;
}
