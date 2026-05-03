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
  /** scene viewport width — needed for pct positioning */
  viewport_width: number;
  /** scene viewport height */
  viewport_height: number;
  speed_px_per_s: number;
  events: RecordedEvent[];
  t_ms: number;
  profile: CursorProfile;
}

export const Cursor: React.FC<CursorRenderProps> = ({
  x,
  y,
  viewport_width,
  viewport_height,
  speed_px_per_s,
  events,
  t_ms,
  profile,
}) => {
  if (!profile.visible) return null;

  // principle 6: click bounce
  const bounce_dur = profile.click_bounce.duration_ms;
  const lastClick = [...events]
    .reverse()
    .find((e) => e.kind === "click" && t_ms >= e.t_ms && t_ms <= e.t_ms + bounce_dur);

  let bounceScale = 1;
  if (lastClick) {
    const local_t = (t_ms - lastClick.t_ms) / bounce_dur;
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

  return (
    <div
      style={{
        position: "absolute",
        left: `${left_pct}%`,
        top: `${top_pct}%`,
        width: size,
        height: size,
        // Bounce around the cursor's tip (its anchor point).
        transformOrigin: "0 0",
        transform: `scale(${bounceScale})`,
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

  // Higher-fidelity macOS-style arrow.
  //
  // Path constructed from scratch (clean-room) to a calibrated silhouette:
  //   - Tip at SVG origin (0, 0) so positioning the cursor div at (x%, y%)
  //     lands the click point exactly at viewport (x, y).
  //   - Tall narrow body (~24×33 design-units), wider at the wing-tail than
  //     a basic triangle — feels like a real cursor, not a generic arrow.
  //   - Black fill with white stroke gives high contrast on any background;
  //     drop shadow pushes it forward of the recording.
  //   - The design takes inspiration from Recordly's Minimal Cursor.svg
  //     (AGPL) but is implemented independently and licensed Apache 2.0.
  //
  // Path breakdown:
  //   M0 0          — tip
  //   L20 14        — diagonal down-right along the body's right edge
  //   L11.5 16      — inner notch where right wing meets the body
  //   L16.5 28.5    — right wing tip (tail point)
  //   L13 30        — bottom of right wing
  //   L8 18         — diagonal up-left back across the body
  //   L0 23         — left edge curving down (gives the body a slight curve)
  //   Z             — close back to tip
  //
  // viewBox includes ~1px padding all around for the stroke.
  const sw = Math.max(1.4, size * 0.075); // stroke width scales with size
  return (
    <svg
      width={size}
      height={size * 1.18}
      viewBox="-1.5 -1.5 24 33"
      style={{
        display: "block",
        filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.45))",
      }}
    >
      <path
        d="M0 0 L20 14 L11.5 16 L16.5 28.5 L13 30 L8 18 L0 23 Z"
        fill="black"
        stroke="white"
        strokeWidth={sw}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
};
