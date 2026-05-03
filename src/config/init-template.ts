/**
 * The polish.config.ts that `openslate init` drops into a project. This is
 * the user-facing surface — every comment is a teaching moment about a
 * principle. Keep it concise but readable.
 */

import { DEFAULT_POLISH_PROFILE } from "../core/defaults.js";
import type { PolishProfile } from "../core/types.js";

export function renderInitTemplate(opts: {
  brand?: Partial<PolishProfile["brand"]>;
} = {}): string {
  const brand = { ...DEFAULT_POLISH_PROFILE.brand, ...(opts.brand ?? {}) };

  return `// polish.config.ts — openSlate motion-design profile.
// Every default below traces to one of the 10 motion-design principles.
// Tweak via your agent: "calmer zooms" / "darker theme" / "snappier cursor".
// You will rarely edit this by hand; the agent handles it.

import { defineProfile } from "openslate";

export default defineProfile({
  brand: {
    primary: "${brand.primary}",
    accent: "${brand.accent}",
    neutral_dark: "${brand.neutral_dark}",
    neutral_light: "${brand.neutral_light}",
    font: "${brand.font}",
  },

  // principle 1: timing & spacing — 60fps non-negotiable.
  capture: {
    target: "browser_desktop",
    viewport: { width: 1280, height: 800 },
    device_pixel_ratio: 2,
    fps: 60,
  },

  // principles 2/3/4/6/7
  cursor: {
    visible: true,
    smoothing: { kind: "spring", stiffness: 180, damping: 22, mass: 1 },
    motion_blur: { px: 8, threshold_velocity_px_per_s: 1200 },
    click_bounce: { scale: [0.92, 1.0], duration_ms: 200, ease: "back_out" },
    pre_click_settle_ms: 200,
    size_multiplier: 1.0,
    style: "system_macos",
    path_arc_amount: 0.0,
  },

  // principles 2/7/8 — the single most important gesture.
  auto_zoom: {
    trigger: "click_event",
    scale: 1.4,
    ease_in: "quart_out",
    ease_out: "cubic_in_out",
    duration_in_ms: 400,
    duration_out_ms: 500,
    hold_after_ms: 700,
    skip_if_within_ms: 800,
    pan_to_target: true,
    cursor_recover_ms: 250,
    max_scale_per_video: 1.6,
  },

  captions: {
    mode: "off",
    position: "lower_third",
    lead_ms: 150,
    style: {
      font_weight: 600,
      stagger_words_ms: 80,
      ease: "cubic_out",
      bg_opacity: 0.85,
      bg_color: "${brand.neutral_dark}",
      text_color: "${brand.neutral_light}",
    },
  },

  frame: {
    style: "laptop_minimal",
    theme: "auto",
    chrome: { url_bar: false, traffic_lights: true },
    radius_px: 12,
    inner_shadow_px: 1,
    shadow_follows_content: true,
  },

  background: {
    style: "gradient_brand",
    blur_px: 0,
    grain_overlay: 0.04,
    parallax_factor: 0.05,
  },

  layout: {
    padding_px: 80,
    frame_radius_px: 12,
    shadow: { px: 32, opacity: 0.22, color: "auto", offset_y_px: 8 },
  },

  intro: { duration_ms: 0 },
  outro: { duration_ms: 800, style: "fade_to_brand", show_logo: false },

  // principle 8 restraint axiom — non-negotiable in v1.
  pacing: {
    max_total_duration_s: { demo: 10, walkthrough: 45, readme_hero: 6 },
    min_hold_between_actions_ms: 600,
    no_simultaneous_polish_gestures: true,
    crossfade_between_clips_ms: 0,
  },

  flourishes: {
    enabled: true,
    outro_logo_reveal: {
      trigger: "outro",
      style: "wordmark_lift",
      duration_ms: 1200,
      use_brand_logo: true,
    },
    click_highlight: {
      enabled_on: "off",
      style: "halo_pulse",
      color: "brand.accent",
      duration_ms: 800,
    },
    step_badges: {
      style: "circular_numeric",
      position: "top_left",
      enabled_on: "walkthrough_only",
    },
    scene_title_card: {
      style: "lower_third_reveal",
      duration_ms: 1500,
      enabled_on: "walkthrough_only",
    },
    success_burst: {
      enabled_on: "off",
      style: "confetti_minimal",
      color: "brand.accent",
    },
  },

  exports: {
    default: { format: "mp4", dimensions: [1920, 1080], bitrate_kbps: 8000 },
    readme_hero: {
      format: "gif",
      dimensions: [800, 480],
      loop: true,
      duration_max_s: 6,
      fps: 24,
    },
    social_vertical: {
      format: "mp4",
      dimensions: [1080, 1920],
      duration_max_s: 30,
      capture_target_override: "browser_mobile",
    },
    twitter_landscape: {
      format: "mp4",
      dimensions: [1920, 1080],
      duration_max_s: 30,
    },
  },
});
`;
}
