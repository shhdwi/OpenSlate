/**
 * Runtime validation for the polish DSL via Zod. Mirrors src/core/types.ts.
 * Use parsePolishProfile() to validate any user-loaded polish.config.ts at
 * load time. Catches typos, out-of-range numbers, and principle violations.
 */

import { z } from "zod";

const easeNames = [
  "linear",
  "quad_in",
  "quad_out",
  "quad_in_out",
  "cubic_in",
  "cubic_out",
  "cubic_in_out",
  "quart_in",
  "quart_out",
  "quart_in_out",
  "quint_in",
  "quint_out",
  "expo_in",
  "expo_out",
  "back_in",
  "back_out",
  "back_in_out",
  "sine_in",
  "sine_out",
  "sine_in_out",
] as const;

const easeSchema = z.enum(easeNames);

const captureTargetSchema = z.enum([
  "browser_desktop",
  "browser_mobile",
  "browser_tablet",
  "window_macos",
]);

const captureSchema = z.object({
  target: captureTargetSchema,
  viewport: z.object({
    width: z.number().int().min(320).max(7680),
    height: z.number().int().min(320).max(4320),
  }),
  device_pixel_ratio: z.number().min(1).max(3),
  fps: z.number().int().refine((v) => v === 60, {
    message: "principle 1 (timing_and_spacing): fps must be 60 in v1; lower fps reads as stutter",
  }),
  browser_zoom: z.number().min(0.5).max(3.0).default(1.0),
});

const cursorSchema = z.object({
  visible: z.boolean(),
  smoothing: z.object({
    kind: z.literal("spring"),
    stiffness: z.number().min(50).max(400),
    damping: z.number().min(8).max(40),
    mass: z.number().min(0.5).max(3),
  }),
  motion_blur: z.object({
    px: z.number().min(0).max(40),
    threshold_velocity_px_per_s: z.number().min(0).max(10000),
  }),
  click_bounce: z.object({
    scale: z.tuple([z.number().min(0.5).max(1), z.number().min(0.9).max(1.5)]),
    duration_ms: z.number().min(50).max(800),
    ease: easeSchema,
  }),
  pre_click_settle_ms: z.number().min(0).max(800),
  size_multiplier: z.number().min(0.5).max(3),
  style: z.enum(["system_macos", "system_windows", "minimal_dot"]),
  contextual_swap: z.boolean().default(true),
  path_arc_amount: z.number().min(0).max(0.5),
});

const zoomTemplateSchema = z.object({
  peak: z.number().min(1.0).max(2.5),
  ease_in: easeSchema,
  ease_out: easeSchema,
  duration_in_ms: z.number().min(0).max(2000),
  hold_ms: z.number().min(0).max(3000),
  duration_out_ms: z.number().min(0).max(2000),
});

const zoomSchema = z.object({
  templates: z.object({
    click: zoomTemplateSchema,
    type: zoomTemplateSchema,
    hover: zoomTemplateSchema,
    scroll: zoomTemplateSchema,
    navigate: zoomTemplateSchema,
  }),
  pan_to_target: z.boolean(),
  cursor_recover_ms: z.number().min(0).max(1000),
  max_peak: z
    .number()
    .min(1)
    .max(2.5)
    .refine((v) => v <= 1.6, {
      message:
        "principle 8 (exaggeration restraint): max_peak must be ≤ 1.6 in v1; higher reads cartoony",
    }),
  skip_if_within_ms: z.number().min(0).max(3000),
  connected_gap_ms: z.number().min(0).max(5000),
});

const playbackSchema = z.object({
  rate: z.number().min(0.25).max(8),
  segment_lead_ms: z.number().min(0).max(2000),
  segment_trail_ms: z.number().min(0).max(5000),
  segment_merge_below_ms: z.number().min(0).max(10000),
  segment_split_above_ms: z.number().min(0).max(15000),
});

const captionsSchema = z.object({
  mode: z.enum(["off", "from_steps", "from_narration"]),
  position: z.enum(["lower_third", "upper_third", "centered"]),
  lead_ms: z.number().min(0).max(500),
  style: z.object({
    font_weight: z.number().int().min(100).max(900),
    stagger_words_ms: z.number().min(20).max(300),
    ease: easeSchema,
    bg_opacity: z.number().min(0).max(1),
    bg_color: z.string(),
    text_color: z.string(),
  }),
});

const frameSchema = z.object({
  style: z.enum([
    "laptop_minimal",
    "phone_minimal",
    "browser_safari",
    "browser_chrome",
    "window_macos",
    "none",
  ]),
  theme: z.enum(["light", "dark", "auto"]),
  chrome: z.object({
    url_bar: z.boolean(),
    traffic_lights: z.boolean(),
    title: z.string().optional(),
  }),
  radius_px: z.number().min(0).max(48),
  inner_shadow_px: z.number().min(0).max(8),
  shadow_follows_content: z.boolean(),
});

const backgroundSchema = z.object({
  style: z.enum([
    "gradient_brand",
    "gradient_sunset",
    "gradient_ocean",
    "gradient_violet",
    "gradient_slate",
    "solid_white",
    "solid_black",
    "wallpaper_minimal_1",
    "wallpaper_minimal_2",
    "wallpaper_minimal_3",
    "image_custom",
  ]),
  custom_image_path: z.string().optional(),
  blur_px: z.number().min(0).max(40),
  grain_overlay: z.number().min(0).max(0.2),
  parallax_factor: z.number().min(0).max(0.2),
});

const layoutSchema = z.object({
  padding_px: z.number().min(0).max(256),
  frame_radius_px: z.number().min(0).max(48),
  shadow: z.object({
    px: z.number().min(0).max(120),
    opacity: z.number().min(0).max(1),
    color: z.string(),
    offset_y_px: z.number().min(-32).max(32),
  }),
});

const introSchema = z.object({ duration_ms: z.number().min(0).max(2000) });
const outroSchema = z.object({
  duration_ms: z.number().min(0).max(3000),
  style: z.enum(["fade_to_brand", "lift_logo", "none"]),
  show_logo: z.boolean(),
});

const pacingSchema = z.object({
  max_total_duration_s: z.object({
    demo: z.number().min(2).max(60),
    walkthrough: z.number().min(10).max(180),
    readme_hero: z.number().min(2).max(15),
  }),
  min_hold_between_actions_ms: z.number().min(100).max(2000),
  no_simultaneous_polish_gestures: z.literal(true), // restraint axiom is non-negotiable in v1
  crossfade_between_clips_ms: z.number().min(0).max(1000),
});

const flourishesSchema = z.object({
  enabled: z.boolean(),
  outro_logo_reveal: z.object({
    trigger: z.enum(["outro", "manual", "scene_end"]),
    style: z.enum(["wordmark_lift", "wordmark_blur_in", "symbol_orbit"]),
    duration_ms: z.number().min(400).max(2400),
    use_brand_logo: z.boolean(),
  }),
  click_highlight: z.object({
    enabled_on: z.enum(["every_click", "manual", "auto_protagonist", "off"]),
    style: z.enum(["halo_pulse", "arrow_callout", "dotted_circle"]),
    color: z.string(),
    duration_ms: z.number().min(200).max(1600),
  }),
  step_badges: z.object({
    style: z.enum(["circular_numeric", "minimal_chip"]),
    position: z.enum(["top_left", "top_right", "bottom_left", "bottom_right"]),
    enabled_on: z.enum(["walkthrough_only", "always", "off"]),
  }),
  scene_title_card: z.object({
    style: z.enum(["lower_third_reveal", "centered_fade", "off"]),
    duration_ms: z.number().min(400).max(3000),
    enabled_on: z.enum(["walkthrough_only", "always", "off"]),
  }),
  success_burst: z.object({
    enabled_on: z.enum(["manual", "off"]),
    style: z.enum(["confetti_minimal", "checkmark_pop", "ring_pulse"]),
    color: z.string(),
  }),
});

const brandSchema = z.object({
  primary: z.string(),
  accent: z.string(),
  neutral_dark: z.string(),
  neutral_light: z.string(),
  font: z.string(),
  logo: z.string().optional(),
});

const exportPresetSchema = z.object({
  format: z.enum(["mp4", "gif", "webm"]),
  dimensions: z.tuple([z.number().int().min(64).max(7680), z.number().int().min(64).max(4320)]),
  bitrate_kbps: z.number().int().optional(),
  loop: z.boolean().optional(),
  fps: z.number().int().min(8).max(120).optional(),
  duration_max_s: z.number().min(1).max(180).optional(),
  capture_target_override: captureTargetSchema.optional(),
});

const exportsSchema = z.object({
  default: exportPresetSchema,
  readme_hero: exportPresetSchema,
  social_vertical: exportPresetSchema,
  twitter_landscape: exportPresetSchema,
});

export const polishProfileSchema = z.object({
  brand: brandSchema,
  capture: captureSchema,
  cursor: cursorSchema,
  zoom: zoomSchema,
  playback: playbackSchema,
  captions: captionsSchema,
  frame: frameSchema,
  background: backgroundSchema,
  layout: layoutSchema,
  intro: introSchema,
  outro: outroSchema,
  pacing: pacingSchema,
  flourishes: flourishesSchema,
  exports: exportsSchema,
  __openslate_version: z.literal(1).optional(),
});

export type ParsedPolishProfile = z.infer<typeof polishProfileSchema>;

export function parsePolishProfile(value: unknown): ParsedPolishProfile {
  const result = polishProfileSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid polish.config.ts:\n${issues}`);
  }
  return result.data;
}
