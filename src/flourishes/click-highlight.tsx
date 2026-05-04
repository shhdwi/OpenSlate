/**
 * Click highlight flourish. Renders a halo / arrow / dotted circle around
 * a protagonist click. Off by default; the agent opts in per-click via the
 * `is_protagonist` event flag or the polish profile's `enabled_on`.
 *
 * principle 9 (secondary_animation): pulses alongside auto-zoom but does not
 * compete with it (restraint axiom enforced upstream by the validator).
 * principle 2 (easings): expanding ring uses cubic_out
 * principle 8 (exaggeration): brief and emphatic (≤800ms)
 */

import React from "react";
import type { FlourishClickHighlight } from "../core/types.js";
import { applyEase } from "../utils/easings.js";
import type { FlourishContext } from "./types.js";

/**
 * Delay between the click event firing and the halo starting to render.
 *
 * Why: the visual cursor is spring-smoothed, so it takes ~200-300ms after
 * the click event for the cursor to *visually* arrive at the click point.
 * Firing the halo at click-event time would mean the halo expands while
 * the cursor is still in transit — feels off.
 *
 * 250ms is calibrated to match the cursor's settling time at the default
 * spring config (stiffness 180, damping 22, mass 1). For snappier cursor
 * configs you'd shorten this; for lazier ones, lengthen.
 */
const CLICK_FX_DELAY_MS = 250;

export interface ClickHighlightProps {
  config: FlourishClickHighlight;
  ctx: FlourishContext;
  /**
   * Viewport dimensions of the recording. Required: click highlights are
   * rendered INSIDE the scene group (which has the recording's aspect
   * ratio), so positioning is done in PERCENTAGES of viewport. Without
   * these, the halo would render at canvas pixel coords and drift from
   * the actual click target.
   */
  viewport_width: number;
  viewport_height: number;
}

export const ClickHighlight: React.FC<ClickHighlightProps> = ({
  config,
  ctx,
  viewport_width,
  viewport_height,
}) => {
  if (config.enabled_on === "off") return null;

  // Find click events whose highlight window covers t_ms. The halo's
  // start is delayed by CLICK_FX_DELAY_MS after the click event so it
  // fires once the cursor has visually arrived at the target.
  const candidates = ctx.events.filter((e) => {
    if (e.kind !== "click") return false;
    if (e.no_zoom) return false; // skip if click was marked no_zoom
    if (config.enabled_on === "auto_protagonist" && !e.is_protagonist) return false;
    if (config.enabled_on === "manual" && !e.is_protagonist) return false;
    const start = e.t_ms + CLICK_FX_DELAY_MS;
    const end = start + config.duration_ms;
    return ctx.t_ms >= start && ctx.t_ms <= end;
  });

  if (candidates.length === 0) return null;

  const color = resolveColor(config.color, ctx.brand);

  // STAGE INVARIANT (see compositor/stage.tsx):
  // This component is rendered as a child of <Stage>. All positions AND
  // sizes are expressed as PERCENTAGES of the viewport / stage. Stage's
  // CSS aspect-ratio guarantees the percentages map to the same RELATIVE
  // recording pixel at any output resolution (mp4 1920×1080, gif 1280×720,
  // future resolutions). Pixel-based sizes would render at different
  // relative sizes per export preset — exactly the gif misalignment bug.

  return (
    <>
      {candidates.map((e, idx) => {
        const local_t = Math.max(
          0,
          Math.min(1, (ctx.t_ms - e.t_ms - CLICK_FX_DELAY_MS) / config.duration_ms),
        );
        const x_pct = ((e.x ?? 0) / viewport_width) * 100;
        const y_pct = ((e.y ?? 0) / viewport_height) * 100;
        return (
          <HighlightForStyle
            key={`hl-${idx}`}
            style={config.style}
            t={local_t}
            x_pct={x_pct}
            y_pct={y_pct}
            color={color}
          />
        );
      })}
    </>
  );
};

interface HighlightStyleProps {
  style: FlourishClickHighlight["style"];
  t: number;
  x_pct: number;
  y_pct: number;
  color: string;
}

const HighlightForStyle: React.FC<HighlightStyleProps> = (p) => {
  switch (p.style) {
    case "halo_pulse":
      return <HaloPulse {...p} />;
    case "dotted_circle":
      return <DottedCircle {...p} />;
    case "arrow_callout":
      return <ArrowCallout {...p} />;
  }
};

const HaloPulse: React.FC<HighlightStyleProps> = ({ t, x_pct, y_pct, color }) => {
  const eased = applyEase("cubic_out", t);
  // Halo size as % of Stage width (stage width-equivalent of viewport).
  // 8% peak diameter ≈ 102px on a 1280-wide recording, 154px on 1920.
  // aspectRatio: 1 keeps it a circle even with width-based sizing.
  const max_diameter_pct = 8;
  const diameter_pct = max_diameter_pct * (0.18 + 0.82 * eased);
  const opacity = (1 - eased) * 0.9;
  return (
    <div
      style={{
        position: "absolute",
        left: `${x_pct}%`,
        top: `${y_pct}%`,
        width: `${diameter_pct}%`,
        aspectRatio: "1 / 1",
        transform: "translate(-50%, -50%)",
        borderRadius: "50%",
        border: `0.25% solid ${color}`,
        opacity,
        boxShadow: `0 0 ${1 + 1.5 * eased}vw ${color}`,
        pointerEvents: "none",
      }}
    />
  );
};

const DottedCircle: React.FC<HighlightStyleProps> = ({ t, x_pct, y_pct, color }) => {
  const eased = applyEase("expo_out", t);
  const max_diameter_pct = 7;
  const diameter_pct = max_diameter_pct * (0.3 + 0.7 * eased);
  const rot = t * 240;
  const opacity = 1 - applyEase("quad_in", Math.max(0, t - 0.6) / 0.4);
  return (
    <div
      style={{
        position: "absolute",
        left: `${x_pct}%`,
        top: `${y_pct}%`,
        width: `${diameter_pct}%`,
        aspectRatio: "1 / 1",
        transform: `translate(-50%, -50%) rotate(${rot}deg)`,
        borderRadius: "50%",
        border: `0.2% dashed ${color}`,
        opacity,
        pointerEvents: "none",
      }}
    />
  );
};

const ArrowCallout: React.FC<HighlightStyleProps> = ({ t, x_pct, y_pct, color }) => {
  const eased = applyEase("back_out", t);
  const offset_pct = (1 - eased) * 1.5;
  const opacity =
    applyEase("cubic_out", Math.min(1, t * 1.4)) *
    (1 - applyEase("quad_in", Math.max(0, t - 0.6) / 0.4));
  return (
    <svg
      width="4%"
      height="4%"
      viewBox="0 0 48 48"
      preserveAspectRatio="xMidYMid meet"
      style={{
        position: "absolute",
        left: `calc(${x_pct}% + ${offset_pct}%)`,
        top: `calc(${y_pct}% + ${offset_pct}%)`,
        opacity,
        pointerEvents: "none",
        filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.35))",
      }}
    >
      <path
        d="M44 4 L20 28 M20 28 L20 16 M20 28 L32 28"
        stroke={color}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
};

function resolveColor(c: string, brand: FlourishContext["brand"]): string {
  if (c === "brand.primary") return brand.primary;
  if (c === "brand.accent") return brand.accent;
  if (c === "brand.neutral_dark") return brand.neutral_dark;
  if (c === "brand.neutral_light") return brand.neutral_light;
  return c;
}
