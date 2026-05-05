/**
 * Visual treatment for `highlight` events. Draws a pulsing border + glow
 * around the highlighted bbox during the camera's hold phase, so the
 * region the camera is framing also reads visually as "this is what
 * we're showing you" — not just "the camera happens to be zoomed here."
 *
 * Lives INSIDE the Stage so it inherits the camera transform — the
 * border tracks the recording-frame's coordinate space and stays
 * locked to the bbox even as the Stage scales/translates.
 *
 * Timing: visible during the IN + HOLD + first half of OUT phases of
 * the highlight envelope. Fades out smoothly with the camera's zoom-
 * out so it doesn't pop.
 */

import React from "react";
import type { BrandKit, ZoomProfile } from "../core/types.js";
import type { RecordedEvent } from "../recorder/events.js";
import { applyEase } from "../utils/easings.js";

export interface HighlightTreatmentProps {
  events: RecordedEvent[];
  t_ms: number;
  viewport_width: number;
  viewport_height: number;
  zoom: ZoomProfile;
  brand: BrandKit;
}

const HIGHLIGHT_BORDER_PX_VIEWPORT_FRACTION = 0.003; // 0.3% of viewport min-dim
const HIGHLIGHT_GLOW_PX = 24;
const HIGHLIGHT_RADIUS_PX = 12;

export const HighlightTreatment: React.FC<HighlightTreatmentProps> = ({
  events,
  t_ms,
  viewport_width,
  viewport_height,
  zoom,
  brand,
}) => {
  // Find the active highlight: most-recent highlight event whose envelope
  // (in + hold + out) covers the current t_ms. Highlight envelope is the
  // template's full duration, anchored at the event's t_ms.
  const tpl = zoom.templates.highlight;
  const total_envelope_ms = tpl.duration_in_ms + tpl.hold_ms + tpl.duration_out_ms;

  const active = [...events]
    .reverse()
    .find(
      (e) =>
        e.kind === "highlight" &&
        typeof e.x === "number" &&
        typeof e.y === "number" &&
        typeof e.w === "number" &&
        typeof e.h === "number" &&
        t_ms >= e.t_ms - tpl.duration_in_ms &&
        t_ms <= e.t_ms + tpl.hold_ms + tpl.duration_out_ms,
    );
  if (
    !active ||
    active.x == null ||
    active.y == null ||
    active.w == null ||
    active.h == null
  ) {
    return null;
  }

  // Compute the local-time progression so we can fade in/out with the
  // camera's zoom envelope. Treatment opacity matches the camera's
  // visibility: ramp up during in, hold at full during hold, fade out
  // during out — same shape as the zoom envelope.
  const dt = t_ms - active.t_ms;
  const inMs = tpl.duration_in_ms;
  const holdMs = tpl.hold_ms;
  const outMs = tpl.duration_out_ms;
  let envelopeOpacity: number;
  if (dt < 0) {
    // pre-event (we matched on t_ms >= e.t_ms - duration_in_ms)
    envelopeOpacity = applyEase(tpl.ease_in, 1 + dt / inMs);
  } else if (dt < holdMs) {
    envelopeOpacity = 1;
  } else {
    const out_t = (dt - holdMs) / outMs;
    envelopeOpacity = 1 - applyEase(tpl.ease_out, Math.min(1, out_t));
  }

  // Pulse inside the hold phase: gentle 1.5s sine-ish breath so the
  // border doesn't read static. Subtle — 0.7..1.0 amplitude.
  const PULSE_PERIOD_MS = 1500;
  const pulse =
    dt >= 0 && dt < holdMs
      ? 0.85 + 0.15 * Math.sin((dt / PULSE_PERIOD_MS) * Math.PI * 2)
      : 1;
  const opacity = envelopeOpacity * pulse;

  // Position via viewport-pct so it tracks the recording's coord space
  // (Stage handles the camera transform; the treatment is a Stage child).
  const left_pct = (active.x! - active.w! / 2) / viewport_width * 100;
  const top_pct = (active.y! - active.h! / 2) / viewport_height * 100;
  const w_pct = (active.w! / viewport_width) * 100;
  const h_pct = (active.h! / viewport_height) * 100;

  // Border thickness scales with the smaller viewport dimension so it
  // reads consistently regardless of zoom level.
  const minDim = Math.min(viewport_width, viewport_height);
  const borderPx = Math.max(2, Math.round(minDim * HIGHLIGHT_BORDER_PX_VIEWPORT_FRACTION));

  // Resolve color: brand.accent if specified as hex, else fallback.
  const color = brand.accent.startsWith("#") ? brand.accent : "#FFC857";

  return (
    <div
      data-flourish="highlight-treatment"
      style={{
        position: "absolute",
        left: `${left_pct}%`,
        top: `${top_pct}%`,
        width: `${w_pct}%`,
        height: `${h_pct}%`,
        borderRadius: HIGHLIGHT_RADIUS_PX,
        border: `${borderPx}px solid ${color}`,
        boxShadow: `0 0 ${HIGHLIGHT_GLOW_PX}px ${color}, inset 0 0 ${HIGHLIGHT_GLOW_PX / 2}px ${color}40`,
        opacity,
        pointerEvents: "none",
        // willChange so chromium doesn't redo the layer for every frame
        willChange: "opacity",
        // Slight outward inset so the border draws OVER the bbox edge
        // (and a hair outside) rather than chopping into the content.
        boxSizing: "border-box",
      }}
    />
  );
};
