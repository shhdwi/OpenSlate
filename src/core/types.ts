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
  /**
   * Cursor size as a multiplier of the base 28px arrow at 1080p output.
   * 1.0 = 28px (Recordly parity); 1.25 = 35px (default — slightly larger
   * for stronger read on 4K monitors and dense product UIs); 1.5+ for
   * social/walkthrough demos where the cursor needs to dominate.
   */
  size_multiplier: number;
  style: "system_macos" | "system_windows" | "minimal_dot";
  /**
   * Contextual cursor swapping. When ON (default for `system_macos`),
   * the renderer picks a sprite from the kind sampled at recording time
   * (arrow / pointer / text / grab / not-allowed). When OFF, the arrow
   * sprite is used at all times. `minimal_dot` style ignores this.
   */
  contextual_swap: boolean;
  /** principle: arcs — v1 = 0 (straight); v1.5 will introduce subtle bezier curvature */
  path_arc_amount: number;
}

// ─── Camera (zoom + pan) ─────────────────────────────────────────────────────
//
// The camera plan is no longer derived implicitly inside the renderer. Instead,
// the `plan` step reads events.json and writes an edit-plan.json containing
// segments + keyframes; the renderer interpolates between keyframes. Per-action
// zoom is configured here as a TEMPLATE (peak scale, durations, easings) that
// the planner instantiates once per matching event.

/** Per-action-type zoom shape. peak=1.0 means "no zoom" (wide). */
export interface ZoomTemplate {
  /** principle: exaggeration — 1.5× is emphatic without cartoony */
  peak: number;
  /** principle: easings — mismatched curves: fast in, soft out */
  ease_in: EaseName;
  ease_out: EaseName;
  /** principle: timing_and_spacing — keyframe-relative durations */
  duration_in_ms: number;
  hold_ms: number;
  duration_out_ms: number;
}

export interface ZoomProfile {
  /** Action-type templates. peak=1.0 disables zoom for that action. */
  templates: {
    click: ZoomTemplate;
    type: ZoomTemplate;
    hover: ZoomTemplate;
    scroll: ZoomTemplate;
    navigate: ZoomTemplate;
    /**
     * `highlight` action template. Unlike other templates, the actual
     * peak is computed PER EVENT from the highlighted element's bbox
     * (smart zoom-to-fit). This template's `peak` field acts as a
     * CEILING — never zoom further than this even for tiny elements.
     * The `hold_ms` is the dwell time on the element; longer than
     * click since the WHOLE point of a highlight is to give the viewer
     * time to read the content.
     */
    highlight: ZoomTemplate;
  };
  pan_to_target: boolean;
  /** principle: follow_through — cursor re-syncs gradually after zoom resolves */
  cursor_recover_ms: number;
  /** principle: exaggeration restraint — hard cap; planner clamps to this */
  max_peak: number;
  /** principle: exaggeration restraint — suppress double-zooms on rapid actions */
  skip_if_within_ms: number;
  /**
   * Connected-pan TIME trigger: when two zoom-ins are within this gap
   * (source time), collapse the out + in into a single sustained zoom
   * that pans focal A → B. Recordly's CHAINED_GAP_MS pattern, preserved.
   */
  connected_gap_ms: number;
  /**
   * Connected-pan SPATIAL trigger: when the focal distance between two
   * consecutive peaks is below this (viewport-normalized, 0..√2),
   * collapse the dip and pan instead — regardless of time gap.
   *
   * The defining problem this prevents: form-internal flows (typing a
   * destination, then clicking an autocomplete option below it; tabbing
   * across a row of date fields) zooming in, out, in, out for every
   * adjacent action. Once the camera is zoomed and the next target is
   * already visible, panning reads infinitely better than thrashing.
   *
   * Default 0.35 (~one third of the viewport diagonal). Below that,
   * adjacent actions visually share the same scene and panning is
   * the natural read; above that, the camera should fully reset.
   */
  connected_focal_dist_max: number;
}

// ─── Playback (segments + speed) ─────────────────────────────────────────────

export interface PlaybackProfile {
  /** Time multiplier on output. 1.0 = realtime; 4.0 = 4× speed (Steel.dev default). */
  rate: number;
  /** Lead-in (ms BEFORE each salient event) included in the segment around it. */
  segment_lead_ms: number;
  /** Trail (ms AFTER each salient event) included in the segment. */
  segment_trail_ms: number;
  /** Two segments separated by less than this are merged. */
  segment_merge_below_ms: number;
  /** A gap of this size or more is treated as dead time and split. */
  segment_split_above_ms: number;
  /**
   * Tail held after the LAST plan step before the recorder stops. Also
   * extends the last salient event's segment trail to this value, so
   * the final page (e.g. flight detail, signup confirmation, results
   * loading state) is visible long enough to read in the output. Set
   * higher than `segment_trail_ms` because the last action often
   * triggers a page load whose render takes longer than mid-flow
   * actions. Default 3000ms.
   */
  final_hold_ms: number;
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
  /**
   * 3D tilt of the framed screen. Defaults to all-zeros (flat — current
   * behavior, no perspective transform applied at all). Non-zero values
   * wrap the Frame in a `perspective(P) rotateX(rx) rotateY(ry)
   * rotateZ(rz)` container, lifting the screen off the page in 3D space.
   *
   * Use `TILT_PRESETS.<name>` for friendly defaults (`tilt_left`,
   * `tilt_right`, `billboard`, `dashboard`), or set the angles directly
   * for custom tilt. The presets ARE just curated angle values — there's
   * no separate "preset" runtime field.
   */
  tilt: TiltProfile;
}

export interface TiltProfile {
  /**
   * Rotation around X (horizontal) axis in degrees. Positive = top tips
   * AWAY from viewer (screen looks down); negative = top tips TOWARD
   * viewer (screen looks up). Range -45..45.
   */
  rotate_x_deg: number;
  /**
   * Rotation around Y (vertical) axis in degrees. Positive = right side
   * tips AWAY (screen turns left); negative = right side tips TOWARD
   * viewer (screen turns right). Range -45..45.
   */
  rotate_y_deg: number;
  /**
   * Rotation around Z (axis pointing at viewer). Standard 2D rotation.
   * Range -45..45.
   */
  rotate_z_deg: number;
  /**
   * Perspective distance in px. Smaller = more dramatic foreshortening
   * (the close edge looks larger relative to the far edge); larger =
   * subtler. Common range 800–2400. Default 1500 reads as a slight
   * "product shot" depth without warping the recording.
   */
  perspective_px: number;
  /**
   * Vertical offset as % of canvas height. Default 0 (center). Used by
   * strong-tilt presets like `flat` to push the tilted screen into the
   * LOWER portion of the canvas, leaving empty space ABOVE — the "table
   * in front of standing viewer" framing. A centered tilted screen
   * fills the canvas and reads as floating-in-space; an offset-down one
   * reads as sitting on a surface in front of you.
   *
   * Range -50..50. Positive = down; negative = up.
   */
  translate_y_pct?: number;
  /**
   * Vertical position of the camera (perspective vanishing point) as
   * % of canvas height. Default 50 (center). For "looking DOWN AT a
   * screen lying flat" — the table-on-the-floor metaphor — set this
   * near the TOP (e.g. 10) so the camera sits above the screen looking
   * down. Combined with strong rotateX, the rotation now reads as the
   * element lying back away from a viewer positioned above it.
   *
   * Without this, a high rotateX with centered perspective-origin
   * shows the screen edge-on (like a closing door), not as a horizontal
   * surface viewed from above.
   *
   * Range 0..100. 0 = top of canvas; 100 = bottom.
   */
  perspective_origin_y_pct?: number;
}

/**
 * Three named tilts (plus `none`):
 *
 *   linear   — gentle 3D, browser still upright; the lightest tilt
 *              that still reads as "this is a screen, not a flat
 *              screenshot." Use as the default opt-in.
 *   angled   — typical product-shot angle (Apple keynote / Vercel
 *              hero / Stripe Atlas style). The screen is clearly
 *              presented at an angle but you can still read every
 *              UI detail. The middle option.
 *   flat     — laid back significantly, like a screen lying on a
 *              desk viewed from above-and-the-side. Strong stylistic
 *              choice; pairs well with simple, bold content.
 *
 * Reference from polish.config.ts:
 *
 *   tilt: TILT_PRESETS.linear,
 *   // or override one field:
 *   tilt: { ...TILT_PRESETS.angled, rotate_y_deg: -12 },
 *
 * The composition automatically scales the framed content to ensure
 * the WHOLE browser tab stays visible after the perspective transform —
 * without auto-fit, the rotated near-edge would extend past the canvas
 * border and crop. See `computeTiltFitScale` in composition.tsx.
 */
export const TILT_PRESETS: Record<
  "none" | "linear" | "angled" | "flat",
  TiltProfile
> = {
  // No tilt — identity. No perspective wrapper rendered.
  none: { rotate_x_deg: 0, rotate_y_deg: 0, rotate_z_deg: 0, perspective_px: 1500 },

  // Subtle 3D, browser upright. Mild horizontal pan + barely-there
  // forward lean + tiny counter-rotate (the -1° Z is what gives it the
  // "casually placed" feel rather than CAD-perfect alignment).
  linear: {
    rotate_x_deg: 2,
    rotate_y_deg: -12,
    rotate_z_deg: -1,
    perspective_px: 1500,
  },

  // Typical product-shot angle — meaningful forward lean + clear
  // horizontal turn. Tighter perspective (1300) for noticeable
  // foreshortening. The "Apple keynote / hero shot" middle option.
  angled: {
    rotate_x_deg: 10,
    rotate_y_deg: -16,
    rotate_z_deg: 0,
    perspective_px: 1300,
  },

  // Lying on a table — viewer standing in front of a desk, looking
  // DOWN AND FORWARD at a screen lying flat on the surface.
  //
  // Five pieces conspire to make this read as "table" rather than
  // "tilted screen floating in space":
  //
  //   1. rotate_x_deg=58 — strong forward tip. The element is mostly
  //      horizontal but not edge-on; content stays readable.
  //   2. rotate_y_deg=-6 — small horizontal turn. The bezels read as
  //      a physical device, not a flat graphic.
  //   3. perspective_origin_y_pct=5 — CAMERA NEAR TOP of canvas. This
  //      is the geometry that makes a positive rotateX read as "lying
  //      back" (viewed from above) rather than "edge-on" (viewed from
  //      a centered camera).
  //   4. translate_y_pct=18 — pushes the tilted screen well into the
  //      LOWER portion of the canvas, leaving empty space above for
  //      the "background of the room behind the table" feel.
  //   5. (NOT in this preset, but applied by the composition): a
  //      screen-space drop-shadow under the rotated element grounds
  //      it on an imaginary floor. Without #5, no combination of the
  //      first four reads as "sitting on a surface." See `tiltInnerStyle`
  //      `filter: drop-shadow(...)` in composition.tsx.
  //
  // Auto-fit additionally shrinks the framed content to ~62%.
  flat: {
    rotate_x_deg: 58,
    rotate_y_deg: -6,
    rotate_z_deg: 0,
    perspective_px: 1400,
    translate_y_pct: 18,
    perspective_origin_y_pct: 5,
  },
};

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

/**
 * Visual treatment applied to `highlight` action regions during the
 * camera's hold phase. Two presets:
 *
 *   - `"spotlight"` (default): dims everything OUTSIDE the bbox so the
 *     highlighted region is the only undimmed area. Adds a subtle
 *     1-pixel ring and drop shadow on the bbox itself, reading as
 *     "this card lifted forward toward the camera." Pairs with the
 *     camera's smart zoom-to-fit. Use this for product reveals: AI-
 *     generated outputs, dashboard widgets, search results.
 *
 *   - `"border_glow"`: pulsing brand-accent border + outer glow around
 *     the bbox. More attention-grabbing, less cinematic. Use this for
 *     tutorial / instructional flows where the user needs an explicit
 *     "look here!" pointer beyond the camera move.
 *
 *   - `"off"`: no treatment. The camera move alone signals attention.
 *     Useful for back-to-back highlights where treatment would feel
 *     repetitive.
 */
export interface FlourishHighlightTreatment {
  style: "spotlight" | "border_glow" | "off";
  /** Spotlight: opacity of the dim layer over non-highlighted regions (0..1). */
  dim_opacity: number;
  /** Rounded-corner radius of the bbox cutout, in viewport-equivalent px. */
  corner_radius_px: number;
  /** Spotlight: render the subtle 1px ring + drop shadow. */
  lift_outline: boolean;
  /**
   * Spotlight: scale factor applied to the highlighted region only —
   * NOT a camera zoom. The bbox content renders at this scale, lifted
   * forward from the page; surrounding content stays at base scale,
   * dimmed underneath. Combined with the drop shadow, reads as "this
   * card popped out of the page toward the viewer."
   *
   * Default 1.15. Set to 1.0 to disable the lift effect (dim-only).
   */
  lift_scale: number;
}

export interface FlourishesProfile {
  enabled: boolean;
  outro_logo_reveal: FlourishOutroLogoReveal;
  click_highlight: FlourishClickHighlight;
  step_badges: FlourishStepBadges;
  scene_title_card: FlourishSceneTitleCard;
  success_burst: FlourishSuccessBurst;
  highlight_treatment: FlourishHighlightTreatment;
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

export type ExportFormat = "mp4" | "gif" | "webm" | "mov";

export interface ExportPreset {
  format: ExportFormat;
  dimensions: [number, number];
  bitrate_kbps?: number;
  loop?: boolean;
  fps?: number;
  duration_max_s?: number;
  capture_target_override?: CaptureTarget;
  /**
   * Render with a transparent background — skips the gradient/wallpaper
   * bg layer in the composition AND uses an alpha-supporting codec so
   * the framed (and possibly tilted) screen sits on transparent, ready
   * to be composited over a website / slide / video editor.
   *
   * Format constraint: only `webm` (VP9 + yuva420p) and `mov` (ProRes
   * 4444) carry alpha. `mp4`/`h264` does NOT support alpha — setting
   * `transparent_bg: true` with `format: "mp4"` is rejected at parse
   * time. `gif` could in principle (1-bit alpha) but the result is
   * fringy; we don't allow it.
   *
   *   Use `webm` for web/Twitter/landing-pages (smaller, broader
   *   support).
   *   Use `mov` (ProRes 4444) for editor pipelines (Final Cut, Premiere)
   *   where you'll re-encode anyway — much larger files but pristine
   *   alpha.
   */
  transparent_bg?: boolean;
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
  zoom: ZoomProfile;
  playback: PlaybackProfile;
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
