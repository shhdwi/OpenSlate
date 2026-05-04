/**
 * Remotion entry. Registers the polish composition. Bundled by tsup as ESM
 * and consumed by `@remotion/bundler` from the headless render path.
 *
 * Composition dimensions/fps/duration are overridden at render time by the
 * orchestrator; what we ship here is the shape and the input prop schema.
 */

import React from "react";
import { Composition, registerRoot } from "remotion";
import { PolishComposition, type CompositionProps } from "./composition.js";
import { DEFAULT_POLISH_PROFILE } from "../core/defaults.js";

// Cast to Remotion's loose-prop-shape; render orchestrator passes the actual
// typed props at render time, and selectComposition validates at runtime.
const PolishCompositionLoose = PolishComposition as unknown as React.FC<Record<string, unknown>>;

const defaultProps = {
  manifest: {
    id: "placeholder",
    created_at: new Date().toISOString(),
    duration_ms: 5000,
    fps: 60,
    viewport: { width: 1280, height: 800 },
    device_pixel_ratio: 2,
    frame_count: 300,
    frame_indices: [],
    frame_timestamps_ms: [],
    start_offset_ms: 0,
    frames_dir: "frames",
    events_file: "events.json",
    cursor_file: "cursor.json",
    plan_file: "plan.json",
    base_url: "http://localhost:3000",
  },
  events: [],
  cursor_samples: [],
  frames_url_prefix: "",
  profile: DEFAULT_POLISH_PROFILE,
  edit_plan: {
    schema_version: 1,
    recording_id: "placeholder",
    playback_rate: 1,
    viewport: { width: 1280, height: 800 },
    segments: [{ src_start_ms: 0, src_end_ms: 5000 }],
    keyframes: [
      { out_t_ms: 0, zoom: 1, focal_x: 0.5, focal_y: 0.5, ease: "linear" as const },
      { out_t_ms: 5000, zoom: 1, focal_x: 0.5, focal_y: 0.5, ease: "linear" as const },
    ],
  },
} satisfies CompositionProps;

const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="polish"
        component={PolishCompositionLoose}
        durationInFrames={300}
        fps={60}
        width={1920}
        height={1080}
        defaultProps={defaultProps as unknown as Record<string, unknown>}
      />
    </>
  );
};

registerRoot(Root);
