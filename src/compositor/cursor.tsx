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
 * SVG anchor: the arrow tip is at SVG (0,0), so positioning the div at
 * (x%, y%) puts the click point exactly at (x, y) in viewport coords.
 *
 * principle 3 (mass_and_weight): cursor light, ~20px on 1080p output
 * principle 6 (squash_and_stretch): click_bounce
 * principle 7 (follow_through): motion blur trail at high speeds
 */

import React from "react";
import type { CursorProfile } from "../core/types.js";
import type { RecordedEvent } from "../recorder/events.js";
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
}

/**
 * Cursor sway calibration.
 * Pattern from Recordly's cursorSway: lean cursor toward direction of motion.
 *   - Speed reference 1400 px/s — at this speed lean approaches max
 *   - Vertical motion contributes 65% of horizontal (subtle bias)
 *   - Max rotation π/18 (10°), scaled here to ~12° for a touch more visceral
 *     read at our 28px size
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

  // Default 28px cursor on 1080p output. Recordly uses 28 as their dotRadius
  // baseline; matches the macOS arrow at retina equivalents and reads
  // clearly without dominating the frame.
  const size = 28 * profile.size_multiplier;

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
  const swayDeg = leanSign * leanMag * speedFactor * SWAY_MAX_DEG;

  return (
    <div
      style={{
        position: "absolute",
        left: `${left_pct}%`,
        top: `${top_pct}%`,
        width: size,
        height: size,
        // Pivot transforms (bounce + sway) around the tip — the cursor's
        // logical anchor point. Ordering: rotate first, then scale, both
        // applied around the tip.
        transformOrigin: "0 0",
        transform: `rotate(${swayDeg}deg) scale(${bounceScale})`,
        filter: blurPx > 0 ? `blur(${blurPx}px)` : undefined,
        willChange: "transform, filter",
        pointerEvents: "none",
      }}
    >
      <CursorIcon style={profile.style} size={size} />
    </div>
  );
};

const CursorIcon: React.FC<{ style: CursorProfile["style"]; size: number }> = ({ style, size }) => {
  if (style === "minimal_dot") {
    return (
      <div
        style={{
          width: size * 0.55,
          height: size * 0.55,
          borderRadius: "50%",
          background: "rgba(0,0,0,0.85)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          transform: `translate(${-size * 0.275}px, ${-size * 0.275}px)`,
        }}
      />
    );
  }

  // Cursor SVG — derived from Recordly's "Minimal Cursor.svg" (AGPL 3.0).
  //
  // ATTRIBUTION: This path data and shape come from Recordly's repository
  // at https://github.com/webadderallorg/Recordly. See NOTICE.md at the
  // openSlate repo root. We carry this asset in good faith for visual
  // parity with Recordly's polish; license tension is documented openly.
  //
  // Geometry: SVG path tip is at (39.97, 31.88) in the source. We translate
  // by (-39.97, -31.88) via the wrapping <g> so the tip lands at SVG (0, 0)
  // — required by our positioning model where the cursor div's top-left
  // corner sits at the click point.
  return (
    <svg
      width={size}
      height={size}
      // viewBox sized to fit the cursor body after the translate, with a
      // small padding margin so the white stroke doesn't clip.
      viewBox="-12 -12 340 360"
      // geometricPrecision keeps the tip pixel-aligned at high zoom levels;
      // default "auto" rounds to integer pixels which can drift the tip
      // by 1–2 px when the scene is scaled up.
      shapeRendering="geometricPrecision"
      style={{
        display: "block",
        filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.35))",
      }}
    >
      <g transform="translate(-39.9744, -31.8759)">
        <path
          d="M39.9744 31.8759C38.2182 23.4825 47.2034 16.9545 54.6432 21.2183L351.11 191.127C358.653 195.45 357.401 206.692 349.09 209.248L205.199 253.511C202.971 254.196 201.054 255.643 199.785 257.599L127.77 368.534C122.94 375.973 111.523 373.84 109.707 365.158L39.9744 31.8759Z"
          fill="#000000"
        />
        <path
          d="M346.169 199.749L202.277 244.012C197.821 245.383 193.988 248.277 191.449 252.188L119.434 363.121L49.7012 29.8407L346.169 199.749Z"
          stroke="white"
          strokeWidth="19.8759"
          fill="none"
        />
      </g>
    </svg>
  );
};
