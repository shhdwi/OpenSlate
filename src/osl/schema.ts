/**
 * Zod validation for the .osl bundle manifest. Run at every read so a
 * malformed or downlevel bundle fails fast with a useful message instead
 * of producing garbled output at render time.
 */

import { z } from "zod";
import { OSL_SCHEMA_VERSION } from "./types.js";

const artifactRefSchema = z.object({
  path: z.string().min(1),
  size_bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
});

const dirRefSchema = z.object({
  path: z.string().min(1),
  count: z.number().int().nonnegative().optional(),
});

const audioInfoSchema = z.object({
  sample_rate: z.number().int().min(8000).max(192000),
  channels: z.union([z.literal(1), z.literal(2)]),
  codec: z.enum(["pcm_s16le", "pcm_f32le", "aac", "opus"]),
  duration_ms: z.number().nonnegative(),
});

export const oslBundleManifestSchema = z.object({
  schema_version: z.literal(OSL_SCHEMA_VERSION),
  bundle_id: z.string().min(1),
  recording_id: z.string().min(1),
  source: z.enum(["mcp", "cli", "mac_app", "webapp", "imported"]),
  capture_backend: z.enum([
    "playwright",
    "screencapturekit",
    "wgc",
    "getdisplaymedia",
  ]),
  created_at: z.string().datetime(),
  modified_at: z.string().datetime(),
  title: z.string().optional(),
  notes: z.string().optional(),
  producer: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  artifacts: z.object({
    manifest: artifactRefSchema,
    events: artifactRefSchema,
    cursor: artifactRefSchema,
    edit_plan: artifactRefSchema,
    polish_config: artifactRefSchema.optional(),
    raw_capture: artifactRefSchema.optional(),
    mic_audio: artifactRefSchema.optional(),
    system_audio: artifactRefSchema.optional(),
    frames_dir: dirRefSchema.optional(),
    thumbnails_dir: dirRefSchema.optional(),
  }),
  audio: z
    .object({
      mic: audioInfoSchema.optional(),
      system: audioInfoSchema.optional(),
    })
    .optional(),
  target: z.object({
    label: z.string().min(1),
    viewport: z.object({
      width: z.number().int().min(1),
      height: z.number().int().min(1),
    }),
    device_pixel_ratio: z.number().min(0.5).max(4),
    fps: z.number().int().min(1).max(240),
  }),
});

export type ParsedOslBundleManifest = z.infer<typeof oslBundleManifestSchema>;
