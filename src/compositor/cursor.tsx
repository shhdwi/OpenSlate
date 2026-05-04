/**
 * The cursor overlay. Renders the smoothed cursor position with motion blur
 * (when fast) and a click bounce (scale animation) at click events.
 *
 * Coordinate model (v1.1):
 * - Cursor lives INSIDE the scene group (alongside the recording <Img>),
 *   not as a sibling at AbsoluteFill level. This keeps the cursor in the
 *   same coordinate space as the recording so auto-zoom transforms apply
 *   to both consistently.
 * - x/y are passed as VIEWPORT coordinates (e.g. 0..1280 / 0..800).
 * - The cursor is positioned via percentage of the scene so it lands on
 *   the right pixel regardless of how the scene is scaled to fit the frame.
 *
 * Sprite + hotspot model (v1.2):
 * - For `system_macos` style with contextual swap, we render Recordly's
 *   sprite for the sampled cursor kind (arrow/pointer/text/grab/not-allowed).
 * - Each sprite has a hotspot — the pixel that should land on the click
 *   point. We pre-translate the wrapping div by -hotspotX% / -hotspotY%
 *   so positioning the div at (x%, y%) lands the hotspot on (x, y).
 *
 * principle 3 (mass_and_weight): cursor light, ~35px on 1080p output (1.25x of 28)
 * principle 6 (squash_and_stretch): click_bounce
 * principle 7 (follow_through): motion blur trail at high speeds
 */

import React from "react";
import { staticFile } from "remotion";
import type { CursorProfile } from "../core/types.js";
import type { CursorKind, RecordedEvent } from "../recorder/events.js";
import { applyEase } from "../utils/easings.js";

export interface CursorRenderProps {
  /** viewport-space x */
  x: number;
  /** viewport-space y */
  y: number;
  /** velocity in viewport-px/s, signed (positive x = rightward, positive y = downward) */
  vx: number;
  vy: number;
  /** scene viewport width — needed for pct positioning */
  viewport_width: number;
  /** scene viewport height */
  viewport_height: number;
  speed_px_per_s: number;
  events: RecordedEvent[];
  t_ms: number;
  profile: CursorProfile;
  /** contextual cursor kind (resolved by the composition from cursor.json) */
  kind?: CursorKind;
}

/**
 * Per-sprite hotspot — the pixel that should land on the click point,
 * in 0..1 normalized to the source SVG bounds. Numbers come straight
 * from Recordly's filename convention: e.g. `pointer-1__34-24.svg`
 * → hotspot at (34/100, 24/100) of the trimmed sprite.
 */
const SPRITE_HOTSPOTS: Record<CursorKind, { x: number; y: number }> = {
  arrow: { x: 0.34, y: 0.24 },
  pointer: { x: 0.39, y: 0.26 },
  text: { x: 0.5, y: 0.5 },
  grab: { x: 0.5, y: 0.5 },
  "not-allowed": { x: 0.23, y: 0.0 },
};

/**
 * Per-sprite size scale — Recordly's macOS sprites have varying intrinsic
 * sizes. We normalize so all kinds visually match the arrow at the same
 * size_multiplier. Tuned by eye against the rendered output.
 */
const SPRITE_SIZE_SCALE: Record<CursorKind, number> = {
  arrow: 1.0,
  pointer: 1.0,
  text: 0.85,
  grab: 1.0,
  "not-allowed": 1.0,
};

/**
 * Cursor sway calibration.
 * Pattern from Recordly's cursorSway: lean cursor toward direction of motion.
 *   - Speed reference 1400 px/s — at this speed lean approaches max
 *   - Vertical motion contributes 65% of horizontal (subtle bias)
 *   - Max rotation π/18 (10°), scaled here to ~12° for a touch more visceral
 *     read at our 28px size
 *
 * Sway is suppressed for non-arrow kinds — rotating an I-beam or hand
 * sprite reads as broken. Arrow is the only sprite with a tip at SVG (0,0)
 * that benefits from leaning.
 */
const SWAY_SPEED_REF_PX_PER_S = 1400;
const SWAY_MAX_DEG = 12;
const SWAY_VERTICAL_WEIGHT = 0.65;

export const Cursor: React.FC<CursorRenderProps> = ({
  x,
  y,
  vx,
  vy,
  viewport_width,
  viewport_height,
  speed_px_per_s,
  events,
  t_ms,
  profile,
  kind = "arrow",
}) => {
  if (!profile.visible) return null;

  // principle 6: click bounce
  // Same delay as the click halo (~250ms): the cursor's spring takes time
  // to settle at the click target, so firing the bounce at click-event-time
  // would scrunch the cursor mid-flight. Wait for visual arrival.
  const CLICK_FX_DELAY_MS = 250;
  const bounce_dur = profile.click_bounce.duration_ms;
  const lastClick = [...events]
    .reverse()
    .find(
      (e) =>
        e.kind === "click" &&
        t_ms >= e.t_ms + CLICK_FX_DELAY_MS &&
        t_ms <= e.t_ms + CLICK_FX_DELAY_MS + bounce_dur,
    );

  let bounceScale = 1;
  if (lastClick) {
    const local_t = (t_ms - lastClick.t_ms - CLICK_FX_DELAY_MS) / bounce_dur;
    const eased = applyEase(profile.click_bounce.ease, Math.min(1, local_t));
    const [from, to] = profile.click_bounce.scale;
    if (local_t < 0.5) {
      bounceScale = from + (1 - from) * (local_t / 0.5);
    } else {
      bounceScale = from + (to - from) * eased;
    }
  }

  // principle 7: motion blur above threshold
  const blurActive = speed_px_per_s > profile.motion_blur.threshold_velocity_px_per_s;
  const blurPx = blurActive
    ? Math.min(
        profile.motion_blur.px,
        (speed_px_per_s / profile.motion_blur.threshold_velocity_px_per_s - 1) *
          profile.motion_blur.px,
      )
    : 0;

  // Default 28px arrow at size_multiplier=1; default profile is 1.25x → 35px.
  const baseSize = 28;
  const size = baseSize * profile.size_multiplier * (SPRITE_SIZE_SCALE[kind] ?? 1);

  // Position by percentage of the scene so cursor lands correctly regardless
  // of how the scene is scaled to fit the frame chrome.
  const left_pct = (x / viewport_width) * 100;
  const top_pct = (y / viewport_height) * 100;

  // Cursor sway — lean cursor toward direction of motion. Combines
  // horizontal + vertical velocity (vertical weighted at 65%) into a
  // single signed scalar; clamps to ±SWAY_MAX_DEG.
  // pattern: Recordly's cursorSway. Implemented independently per NOTICE.md.
  const speedFactor = Math.min(1, speed_px_per_s / SWAY_SPEED_REF_PX_PER_S);
  const directionalLean = vx + vy * SWAY_VERTICAL_WEIGHT;
  const leanMag = speed_px_per_s > 1 ? Math.abs(directionalLean) / speed_px_per_s : 0;
  const leanSign = directionalLean >= 0 ? 1 : -1;
  // Only sway the arrow. Other sprites (hand, I-beam, grab) look wrong rotated.
  const swayDeg = kind === "arrow" ? leanSign * leanMag * speedFactor * SWAY_MAX_DEG : 0;

  // The sprite hotspot is normalized 0..1 of the sprite bbox. We want the
  // hotspot to land at (left_pct, top_pct), so we offset the inner sprite
  // by -hotspot * size in pixels. Outer div is positioned via pct, inner
  // <img> is offset by px so the hotspot anchor is exact.
  const hotspot = SPRITE_HOTSPOTS[kind] ?? SPRITE_HOTSPOTS.arrow;
  const offsetX = -hotspot.x * size;
  const offsetY = -hotspot.y * size;

  return (
    <div
      style={{
        position: "absolute",
        left: `${left_pct}%`,
        top: `${top_pct}%`,
        width: 0,
        height: 0,
        // Pivot transforms (bounce + sway) around the hotspot — the cursor's
        // logical anchor point.
        transformOrigin: "0 0",
        transform: `rotate(${swayDeg}deg) scale(${bounceScale})`,
        filter: blurPx > 0 ? `blur(${blurPx}px)` : undefined,
        willChange: "transform, filter",
        pointerEvents: "none",
      }}
    >
      <CursorIcon
        style={profile.style}
        kind={kind}
        contextual_swap={profile.contextual_swap}
        size={size}
        offsetX={offsetX}
        offsetY={offsetY}
      />
    </div>
  );
};

const CursorIcon: React.FC<{
  style: CursorProfile["style"];
  kind: CursorKind;
  contextual_swap: boolean;
  size: number;
  offsetX: number;
  offsetY: number;
}> = ({ style, kind, contextual_swap, size, offsetX, offsetY }) => {
  if (style === "minimal_dot") {
    return (
      <div
        style={{
          position: "absolute",
          width: size * 0.55,
          height: size * 0.55,
          borderRadius: "50%",
          background: "rgba(0,0,0,0.85)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          left: -size * 0.275,
          top: -size * 0.275,
        }}
      />
    );
  }

  // system_macos / system_windows — render the sprite SVG. When contextual
  // swap is off, force `arrow` so the user gets a stable pointer.
  // Sprites resolve through Remotion's serveURL: render.ts copies them
  // into <recording_dir>/cursors/ before bundle, and publicDir=recording_dir
  // makes staticFile() serve them from the bundle origin.
  //
  // ATTRIBUTION: cursor sprite SVGs are derived from Recordly (AGPL 3.0).
  // See NOTICE.md at the openSlate repo root.
  const effectiveKind: CursorKind = contextual_swap ? kind : "arrow";
  return (
    <img
      src={staticFile(`cursors/${effectiveKind}.svg`)}
      alt=""
      width={size}
      height={size}
      style={{
        position: "absolute",
        left: offsetX,
        top: offsetY,
        width: size,
        height: size,
        display: "block",
        // Drop shadow gives the cursor weight against light/dark backgrounds
        // both — avoids the "floating sticker" look.
        filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.35))",
        // Without this, the SVG can render rounded by chromium's image
        // smoothing and the tip drifts 1-2px off the click point.
        imageRendering: "crisp-edges",
      }}
    />
  );
};
