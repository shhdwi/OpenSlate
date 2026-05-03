/**
 * The cursor overlay. Renders the smoothed cursor position with motion blur
 * (when fast) and a click bounce (scale animation) at click events.
 *
 * principle 3 (mass_and_weight): light cursor — small, low-inertia
 * principle 6 (squash_and_stretch): click_bounce
 * principle 7 (follow_through): motion blur trail at high speeds
 */

import React from "react";
import type { CursorProfile } from "../core/types.js";
import type { RecordedEvent } from "../recorder/events.js";
import { applyEase } from "../utils/easings.js";

export interface CursorRenderProps {
  x: number;
  y: number;
  speed_px_per_s: number;
  events: RecordedEvent[];
  t_ms: number;
  profile: CursorProfile;
}

export const Cursor: React.FC<CursorRenderProps> = ({
  x,
  y,
  speed_px_per_s,
  events,
  t_ms,
  profile,
}) => {
  if (!profile.visible) return null;

  // principle 6: click bounce
  // Find the most recent click event whose bounce window covers t_ms.
  const bounce_dur = profile.click_bounce.duration_ms;
  const lastClick = [...events]
    .reverse()
    .find((e) => e.kind === "click" && t_ms >= e.t_ms && t_ms <= e.t_ms + bounce_dur);

  let bounceScale = 1;
  if (lastClick) {
    const local_t = (t_ms - lastClick.t_ms) / bounce_dur; // 0..1
    const eased = applyEase(profile.click_bounce.ease, Math.min(1, local_t));
    const [from, to] = profile.click_bounce.scale;
    // First half: compress; second half: rebound (with back_out overshoot via ease)
    if (local_t < 0.5) {
      bounceScale = from + (1 - from) * (local_t / 0.5);
    } else {
      bounceScale = from + (to - from) * eased;
    }
  }

  // principle 7: motion blur kicks in above threshold
  const blurActive = speed_px_per_s > profile.motion_blur.threshold_velocity_px_per_s;
  const blurPx = blurActive
    ? Math.min(
        profile.motion_blur.px,
        (speed_px_per_s / profile.motion_blur.threshold_velocity_px_per_s - 1) *
          profile.motion_blur.px,
      )
    : 0;

  const size = 28 * profile.size_multiplier;
  const transform = `translate(${x - size / 2}px, ${y - size / 2}px) scale(${bounceScale})`;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: size,
        height: size,
        transform,
        filter: blurPx > 0 ? `blur(${blurPx}px)` : undefined,
        willChange: "transform, filter",
        pointerEvents: "none",
      }}
    >
      <CursorIcon style={profile.style} />
    </div>
  );
};

const CursorIcon: React.FC<{ style: CursorProfile["style"] }> = ({ style }) => {
  if (style === "minimal_dot") {
    return (
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "rgba(0,0,0,0.85)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          transform: "translate(7px, 7px)",
        }}
      />
    );
  }
  // macOS-ish arrow — abstract, non-trademarked.
  // Simple SVG; v1.5 will swap to higher-fidelity tracings.
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))" }}
    >
      <path
        d="M5 3 L5 19 L9.5 14.5 L12.5 21 L15 20 L12 13.5 L18 13.5 Z"
        fill="white"
        stroke="black"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
};
