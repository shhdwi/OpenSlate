/**
 * The default polish profile. Every numerical default is a calibrated taste
 * decision derived from the benchmark week. Comments name the principle and
 * the rationale; if a field has no principle annotation, it's a vibes value
 * and should be revisited.
 *
 * Final numbers will be re-tuned at the end of the benchmark week (May 17,
 * 2026). Until then, these are the v0 starting points.
 */

import type { PolishProfile } from "./types.js";

export const DEFAULT_POLISH_PROFILE: PolishProfile = {
  brand: {
    primary: "#5B5BFF",
    accent: "#FFC857",
    neutral_dark: "#0A0A0F",
    neutral_light: "#F7F7FA",
    font: "Inter",
  },

  // principle 1: timing_and_spacing — 60fps non-negotiable.
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
    pre_click_settle_ms: 200, // principle 4
    size_multiplier: 1.0,
    style: "system_macos",
    // principle 5 (arcs): subtle upward bezier on long cursor traversals.
    // 0.12 = ~12% of travel distance lifted upward at the midpoint.
    // Set 0 to disable; >0.25 starts looking cartoony.
    path_arc_amount: 0.12,
  },

  // principles 2/7/8
  auto_zoom: {
    trigger: "click_event",
    // 1.4× is the calibrated default. The compositor's focal-clamp pattern
    // (compositor/auto-zoom.ts: getFocusBoundsForScale) keeps the recording
    // covering the frame at any zoom level — the focal point is clamped
    // into the achievable window rather than the pan being clamped.
    scale: 1.4,
    // Asymmetric durations — zoom-IN is slower than zoom-OUT. Recordly uses
    // ~1.5x ratio (1522ms in / 1015ms out); we use 600/400 = 1.5x. Slower in
    // reads as deliberate; faster out keeps cuts crisp.
    ease_in: "quart_out",
    ease_out: "cubic_in_out",
    duration_in_ms: 600,
    duration_out_ms: 400,
    hold_after_ms: 700,
    skip_if_within_ms: 800, // principle 8 restraint (suppress double-zooms)
    pan_to_target: true,
    cursor_recover_ms: 250, // principle 7
    max_scale_per_video: 1.6, // principle 8 restraint cap
  },

  // principles 1/2/4
  captions: {
    mode: "off", // silent demos travel further on Twitter
    position: "lower_third",
    lead_ms: 150, // principle 4: lead the action
    style: {
      font_weight: 600,
      stagger_words_ms: 80,
      ease: "cubic_out",
      bg_opacity: 0.85,
      bg_color: "#0A0A0F",
      text_color: "#F7F7FA",
    },
  },

  // principle 3 + appeal default
  // browser_safari is the v1 default — most demos are web app demos, and a
  // Mac-style browser chrome is the most universally recognized "this is a
  // web app" frame. URL bar is on so the recording reads as a real browser
  // session, not just a windowed app.
  frame: {
    style: "browser_safari",
    theme: "auto",
    chrome: { url_bar: true, traffic_lights: true },
    radius_px: 12,
    inner_shadow_px: 1,
    shadow_follows_content: true, // principle 9
  },

  // principles 9/10
  background: {
    style: "gradient_brand",
    blur_px: 0,
    grain_overlay: 0.04, // principle 10: anti-CGI sterility
    parallax_factor: 0.05, // principle 9: subliminal bg drift during zoom
  },

  // principles 3/8/10
  layout: {
    padding_px: 80, // principle 10: generosity
    frame_radius_px: 12,
    shadow: { px: 32, opacity: 0.22, color: "auto", offset_y_px: 8 },
  },

  intro: { duration_ms: 0 }, // respect viewer's scroll thumb
  outro: { duration_ms: 800, style: "fade_to_brand", show_logo: false },

  // principles 1/8 — restraint axiom
  pacing: {
    max_total_duration_s: { demo: 10, walkthrough: 45, readme_hero: 6 },
    min_hold_between_actions_ms: 600,
    no_simultaneous_polish_gestures: true,
    crossfade_between_clips_ms: 0, // hard cuts only
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
      enabled_on: "off", // off by default; agent opts in per protagonist click
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
};
