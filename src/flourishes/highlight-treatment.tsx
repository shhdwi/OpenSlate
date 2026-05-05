/**
 * Visual treatment for `highlight` events. Lives INSIDE the Stage so
 * it inherits the camera transform — bbox-positioned overlays track
 * the recording's coordinate space and stay locked to the highlighted
 * element even as the Stage scales / translates.
 *
 * Two presets selected via `profile.flourishes.highlight_treatment.style`:
 *
 *   "spotlight" (default)
 *      Dims everything OUTSIDE the bbox via the box-shadow trick:
 *      a div sized to the bbox with a huge `0 0 0 9999px` outer shadow
 *      fills the rest of the Stage with a dim layer; the bbox itself is
 *      the only undimmed region. Adds a subtle 1px ring + soft drop
 *      shadow on the bbox, reading as "this card lifted forward."
 *      Pairs naturally with the smart zoom-to-fit.
 *
 *   "border_glow"
 *      Pulsing brand-accent border + outer/inner glow. More attention-
 *      grabbing, less cinematic. For tutorial/instructional flows.
 *
 *   "off"
 *      No treatment.
 *
 * Timing: the treatment is visible during the highlight envelope —
 * fades in during `duration_in_ms`, holds at full during `hold_ms`,
 * fades out during `duration_out_ms`. Opacity matches the camera's
 * zoom envelope so the treatment doesn't pop in/out.
 */

import React from "react";
import type { BrandKit, FlourishHighlightTreatment, ZoomProfile } from "../core/types.js";
import type { RecordedEvent } from "../recorder/events.js";
import { applyEase } from "../utils/easings.js";

export interface HighlightTreatmentProps {
  events: RecordedEvent[];
  t_ms: number;
  viewport_width: number;
  viewport_height: number;
  zoom: ZoomProfile;
  brand: BrandKit;
  config: FlourishHighlightTreatment;
}

interface ActiveHighlight {
  ev: RecordedEvent;
  envelope_opacity: number;
  pulse: number;
  in_hold_phase: boolean;
}

function findActiveHighlight(
  events: RecordedEvent[],
  t_ms: number,
  zoom: ZoomProfile,
): ActiveHighlight | null {
  const tpl = zoom.templates.highlight;
  const inMs = tpl.duration_in_ms;
  const holdMs = tpl.hold_ms;
  const outMs = tpl.duration_out_ms;
  const ev = [...events]
    .reverse()
    .find(
      (e) =>
        e.kind === "highlight" &&
        typeof e.x === "number" &&
        typeof e.y === "number" &&
        typeof e.w === "number" &&
        typeof e.h === "number" &&
        t_ms >= e.t_ms - inMs &&
        t_ms <= e.t_ms + holdMs + outMs,
    );
  if (!ev) return null;
  const dt = t_ms - ev.t_ms;
  let envelope_opacity: number;
  if (dt < 0) {
    envelope_opacity = applyEase(tpl.ease_in, 1 + dt / inMs);
  } else if (dt < holdMs) {
    envelope_opacity = 1;
  } else {
    const out_t = (dt - holdMs) / outMs;
    envelope_opacity = 1 - applyEase(tpl.ease_out, Math.min(1, out_t));
  }
  // Subtle 1.5s sine-breath pulse during hold only. Dimmer treatments
  // (spotlight) get a smaller-amplitude pulse since the scene is already
  // visually static; the pulse mostly reads on the border_glow style.
  const PULSE_PERIOD_MS = 1500;
  const pulse =
    dt >= 0 && dt < holdMs
      ? 0.9 + 0.1 * Math.sin((dt / PULSE_PERIOD_MS) * Math.PI * 2)
      : 1;
  return { ev, envelope_opacity, pulse, in_hold_phase: dt >= 0 && dt < holdMs };
}

function bboxStyle(
  ev: RecordedEvent,
  viewport_width: number,
  viewport_height: number,
): React.CSSProperties {
  // ev.x/y are the bbox CENTER in viewport pixels; ev.w/h are the bbox
  // dimensions. Convert to the top-left + size for absolute positioning
  // inside the Stage (which is in viewport-pct space).
  const left_pct = ((ev.x! - ev.w! / 2) / viewport_width) * 100;
  const top_pct = ((ev.y! - ev.h! / 2) / viewport_height) * 100;
  const w_pct = (ev.w! / viewport_width) * 100;
  const h_pct = (ev.h! / viewport_height) * 100;
  return {
    position: "absolute",
    left: `${left_pct}%`,
    top: `${top_pct}%`,
    width: `${w_pct}%`,
    height: `${h_pct}%`,
  };
}

export const HighlightTreatment: React.FC<HighlightTreatmentProps> = ({
  events,
  t_ms,
  viewport_width,
  viewport_height,
  zoom,
  brand,
  config,
}) => {
  if (config.style === "off") return null;
  const active = findActiveHighlight(events, t_ms, zoom);
  if (!active) return null;
  const opacity = active.envelope_opacity * active.pulse;

  if (config.style === "spotlight") {
    // Spotlight: dim everything outside the bbox via the box-shadow
    // trick. A second div on top of it adds the lift outline + drop
    // shadow without being clipped by the dim layer's shadow coverage.
    //
    // Why two divs (not one): box-shadow renders OUTSIDE the box, so a
    // single div would have its lift outline inside the dim's shadow
    // area and become invisible. Stacking lets the lift sit on top.
    const dimRgba = `rgba(0, 0, 0, ${config.dim_opacity * opacity})`;
    const outlineRgba = `rgba(255, 255, 255, ${0.35 * opacity})`;
    const dropRgba = `rgba(0, 0, 0, ${0.5 * opacity})`;
    const bbox = bboxStyle(active.ev, viewport_width, viewport_height);
    return (
      <>
        {/* Dim layer — single huge box-shadow fills the rest of the Stage */}
        <div
          data-flourish="highlight-spotlight-dim"
          style={{
            ...bbox,
            borderRadius: config.corner_radius_px,
            boxShadow: `0 0 0 9999px ${dimRgba}`,
            pointerEvents: "none",
            willChange: "opacity, box-shadow",
          }}
        />
        {/* Lift: subtle ring + drop shadow. Z-stacks above the dim. */}
        {config.lift_outline && (
          <div
            data-flourish="highlight-spotlight-lift"
            style={{
              ...bbox,
              borderRadius: config.corner_radius_px,
              boxShadow: `0 0 0 1px ${outlineRgba}, 0 12px 36px ${dropRgba}`,
              pointerEvents: "none",
              willChange: "opacity, box-shadow",
            }}
          />
        )}
      </>
    );
  }

  if (config.style === "border_glow") {
    // Original treatment: pulsing brand-accent border + outer glow.
    const minDim = Math.min(viewport_width, viewport_height);
    const borderPx = Math.max(2, Math.round(minDim * 0.003));
    const color = brand.accent.startsWith("#") ? brand.accent : "#FFC857";
    return (
      <div
        data-flourish="highlight-border-glow"
        style={{
          ...bboxStyle(active.ev, viewport_width, viewport_height),
          borderRadius: config.corner_radius_px,
          border: `${borderPx}px solid ${color}`,
          boxShadow: `0 0 24px ${color}, inset 0 0 12px ${color}40`,
          opacity,
          pointerEvents: "none",
          willChange: "opacity",
          boxSizing: "border-box",
        }}
      />
    );
  }

  return null;
};
