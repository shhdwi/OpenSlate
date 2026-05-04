/**
 * The polish DSL. This is the motion-design vocabulary openSlate uses.
 *
 * Every field's default value traces to one or more of the 10 principles
 * (see ./principles.ts). Comments name the principle so the rationale is
 * always visible in the source.
 */

import type { EaseName } from "./principles.js";

// ─── Capture target ──────────────────────────────────────────────────────────

export type CaptureTarget =
  | "browser_desktop"
  | "browser_mobile"
  | "browser_tablet"
  | "window_macos";

export interface CaptureProfile {
  target: CaptureTarget;
  viewport: { width: number; height: number };
  device_pixel_ratio: number;
  /** principle: timing_and_spacing — 60fps is the floor; below it, every other principle reads as stutter. */
  fps: number;
  /**
   * Browser zoom level — applied via CSS `zoom` to document.documentElement
   * after every page navigation. Equivalent to the user pressing Cmd-+ in
   * a real browser. Useful when the recorded site has tiny UI that doesn't
   * read well at 1080p output. Default 1.0 (no zoom). Range 0.5–3.0.
   *
   * 1.0 = native (no change)
   * 1.25 = "Cmd-+" once (good readability for dense apps)
   * 1.5 = comfortable for text-heavy demos
   */
  browser_zoom: number;
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

export interface CursorSpring {
  kind: "spring";
  stiffness: number;
  damping: number;
  mass: number;
}

export interface CursorMotionBlur {
  px: number;
  threshold_velocity_px_per_s: number;
}

export interface CursorClickBounce {
  scale: [number, number]; // [compressed, full]; e.g., [0.92, 1.0]
  duration_ms: number;
  ease: EaseName;
}

export interface CursorProfile {
  visible: boolean;
  /** principle: mass_and_weight, easings — spring smoothing, never linear */
  smoothing: CursorSpring;
  /** principle: follow_through — motion blur trail behind fast cursor */
  motion_blur: CursorMotionBlur;
  /** principle: squash_and_stretch — restrained scale bounce on click */
  click_bounce: CursorClickBounce;
  /** principle: anticipation — cursor arrives, holds, then clicks */
  pre_click_settle_ms: number;
  size_multiplier: number;
  style: "system_macos" | "system_windows" | "minimal_dot";
  /** principle: arcs — v1 = 0 (straight); v1.5 will introduce subtle bezier curvature */
  path_arc_amount: number;
}

// ─── Auto-zoom ───────────────────────────────────────────────────────────────

export type AutoZoomTrigger = "click_event" | "focus_change" | "navigation" | "manual";

export interface AutoZoomProfile {
  trigger: AutoZoomTrigger;
  /** principle: exaggeration — 1.4× is emphatic without cartoony */
  scale: number;
  /** principle: easings — mismatched curves: fast in, soft out */
  ease_in: EaseName;
  ease_out: EaseName;
  /** principle: timing_and_spacing — 400ms in = 24 frames @ 60fps */
  duration_in_ms: number;
  duration_out_ms: number;
  hold_after_ms: number;
  /** principle: exaggeration restraint — suppress double-zooms on rapid clicks */
  skip_if_within_ms: number;
  pan_to_target: boolean;
  /** principle: follow_through — cursor re-syncs gradually after zoom resolves */
  cursor_recover_ms: number;
  /** principle: exaggeration restraint — hard cap; agents must not exceed */
  max_scale_per_video: number;
  /** principle: anticipation — pre-zoom directional drift toward upcoming target (v1.5+) */
  anticipation_drift_amount?: number;
  anticipation_drift_ms?: number;
}

// ─── Captions ────────────────────────────────────────────────────────────────

export type CaptionsMode = "off" | "from_steps" | "from_narration";

export interface CaptionsProfile {
  mode: CaptionsMode;
  position: "lower_third" | "upper_third" | "centered";
  /** principle: anticipation — captions appear ahead of the action */
  lead_ms: number;
  style: {
    font_weight: number;
    /** principle: timing_and_spacing — 80ms = 5 frames @ 60fps between words */
    stagger_words_ms: number;
    /** principle: easings */
    ease: EaseName;
    bg_opacity: number;
    bg_color: string;
    text_color: string;
  };
}

// ─── Frame (device chrome) ───────────────────────────────────────────────────

export type FrameStyle =
  | "laptop_minimal"
  | "phone_minimal"
  | "browser_safari"
  | "browser_chrome"
  | "window_macos"
  | "none";

export interface FrameProfile {
  style: FrameStyle;
  theme: "light" | "dark" | "auto";
  chrome: {
    url_bar: boolean;
    traffic_lights: boolean;
    title?: string;
  };
  radius_px: number;
  /** principle: mass_and_weight — inset shadow communicates physical depth */
  inner_shadow_px: number;
  /** principle: secondary_animation — frame shadow shifts during zoom */
  shadow_follows_content: boolean;
}

// ─── Background ──────────────────────────────────────────────────────────────

export type BackgroundStyle =
  | "gradient_brand"
  | "gradient_sunset"
  | "gradient_ocean"
  | "gradient_violet"
  | "gradient_slate"
  | "solid_white"
  | "solid_black"
  | "wallpaper_minimal_1"
  | "wallpaper_minimal_2"
  | "wallpaper_minimal_3"
  | "image_custom";

export interface BackgroundProfile {
  style: BackgroundStyle;
  custom_image_path?: string;
  blur_px: number;
  /** principle: appeal — subtle film grain prevents pure-CGI sterility */
  grain_overlay: number;
  /** principle: secondary_animation — bg drifts opposite to zoom motion */
  parallax_factor: number;
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export interface LayoutShadow {
  px: number;
  opacity: number;
  color: string; // "auto" or hex
  offset_y_px: number;
}

export interface LayoutProfile {
  /** principle: appeal — generous padding reads as care */
  padding_px: number;
  frame_radius_px: number;
  /** principle: mass_and_weight, exaggeration — visible shadow grounds frame */
  shadow: LayoutShadow;
}

// ─── Intro / Outro ───────────────────────────────────────────────────────────

export interface IntroProfile {
  duration_ms: number;
}

export interface OutroProfile {
  duration_ms: number;
  style: "fade_to_brand" | "lift_logo" | "none";
  show_logo: boolean;
}

// ─── Pacing constraints ──────────────────────────────────────────────────────

export interface PacingProfile {
  max_total_duration_s: {
    demo: number;
    walkthrough: number;
    readme_hero: number;
  };
  /** principle: timing_and_spacing — minimum hold gives the eye a chance */
  min_hold_between_actions_ms: number;
  /** principle: exaggeration restraint axiom — one polish gesture per moment */
  no_simultaneous_polish_gestures: boolean;
  crossfade_between_clips_ms: number;
}

// ─── Flourishes ──────────────────────────────────────────────────────────────

export interface FlourishOutroLogoReveal {
  trigger: "outro" | "manual" | "scene_end";
  style: "wordmark_lift" | "wordmark_blur_in" | "symbol_orbit";
  duration_ms: number;
  use_brand_logo: boolean;
}

export interface FlourishClickHighlight {
  /**
   * - "every_click" — fires on every zoom-eligible click (default)
   * - "auto_protagonist" — only on clicks marked is_protagonist
   * - "manual" — only on clicks the agent explicitly opts into
   * - "off" — never
   */
  enabled_on: "every_click" | "manual" | "auto_protagonist" | "off";
  style: "halo_pulse" | "arrow_callout" | "dotted_circle";
  color: string; // "brand.accent" | hex
  duration_ms: number;
}

export interface FlourishStepBadges {
  style: "circular_numeric" | "minimal_chip";
  position: "top_left" | "top_right" | "bottom_left" | "bottom_right";
  enabled_on: "walkthrough_only" | "always" | "off";
}

export interface FlourishSceneTitleCard {
  style: "lower_third_reveal" | "centered_fade" | "off";
  duration_ms: number;
  enabled_on: "walkthrough_only" | "always" | "off";
}

export interface FlourishSuccessBurst {
  enabled_on: "manual" | "off";
  style: "confetti_minimal" | "checkmark_pop" | "ring_pulse";
  color: string;
}

export interface FlourishesProfile {
  enabled: boolean;
  outro_logo_reveal: FlourishOutroLogoReveal;
  click_highlight: FlourishClickHighlight;
  step_badges: FlourishStepBadges;
  scene_title_card: FlourishSceneTitleCard;
  success_burst: FlourishSuccessBurst;
}

// ─── Brand kit ───────────────────────────────────────────────────────────────

export interface BrandKit {
  primary: string;
  accent: string;
  neutral_dark: string;
  neutral_light: string;
  font: string;
  logo?: string;
}

// ─── Export presets ──────────────────────────────────────────────────────────

export type ExportFormat = "mp4" | "gif" | "webm";

export interface ExportPreset {
  format: ExportFormat;
  dimensions: [number, number];
  bitrate_kbps?: number;
  loop?: boolean;
  fps?: number;
  duration_max_s?: number;
  capture_target_override?: CaptureTarget;
}

export interface ExportsProfile {
  default: ExportPreset;
  readme_hero: ExportPreset;
  social_vertical: ExportPreset;
  twitter_landscape: ExportPreset;
}

// ─── Top-level polish profile ────────────────────────────────────────────────

export interface PolishProfile {
  brand: BrandKit;
  capture: CaptureProfile;
  cursor: CursorProfile;
  auto_zoom: AutoZoomProfile;
  captions: CaptionsProfile;
  frame: FrameProfile;
  background: BackgroundProfile;
  layout: LayoutProfile;
  intro: IntroProfile;
  outro: OutroProfile;
  pacing: PacingProfile;
  flourishes: FlourishesProfile;
  exports: ExportsProfile;
}

/**
 * The shape returned by `defineProfile()`. Lets us add metadata in the future
 * without breaking config files.
 */
export type DefineProfileResult = PolishProfile & { __openslate_version: 1 };

export function defineProfile(p: PolishProfile): DefineProfileResult {
  return { ...p, __openslate_version: 1 };
}
