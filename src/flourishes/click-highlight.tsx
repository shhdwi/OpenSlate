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

  // Find click events whose highlight window covers t_ms. Filter by mode:
  //   - every_click: every zoom-eligible click (default)
  //   - auto_protagonist: only is_protagonist
  //   - manual: only events the agent flags explicitly (currently no
  //     opt-in on the recorder side, so defaults to no highlights)
  const candidates = ctx.events.filter((e) => {
    if (e.kind !== "click") return false;
    if (e.no_zoom) return false; // skip if click was marked no_zoom
    if (config.enabled_on === "auto_protagonist" && !e.is_protagonist) return false;
    if (config.enabled_on === "manual" && !e.is_protagonist) return false;
    return ctx.t_ms >= e.t_ms && ctx.t_ms <= e.t_ms + config.duration_ms;
  });

  if (candidates.length === 0) return null;

  const color = resolveColor(config.color, ctx.brand);

  // STAGE INVARIANT (see compositor/stage.tsx):
  // This component is rendered as a child of <Stage>. All positions are
  // expressed as PERCENTAGES of the viewport dimensions, NOT canvas
  // pixels. Stage's CSS aspect-ratio guarantees the percentage maps
  // exactly to the recording's pixel coordinate.
  const viewport_diagonal = Math.hypot(viewport_width, viewport_height);

  return (
    <>
      {candidates.map((e, idx) => {
        const local_t = Math.max(0, Math.min(1, (ctx.t_ms - e.t_ms) / config.duration_ms));
        const x_pct = ((e.x ?? 0) / viewport_width) * 100;
        const y_pct = ((e.y ?? 0) / viewport_height) * 100;
        return (
          <HighlightForStyle
            key={`hl-${idx}`}
            style={config.style}
            t={local_t}
            x_pct={x_pct}
            y_pct={y_pct}
            viewport_diagonal={viewport_diagonal}
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
  /** Used to size the halo so it scales with the recording, not canvas. */
  viewport_diagonal: number;
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

const HaloPulse: React.FC<HighlightStyleProps> = ({ t, x_pct, y_pct, viewport_diagonal, color }) => {
  const eased = applyEase("cubic_out", t);
  // Halo radius is scaled to the viewport diagonal so it reads at any
  // recording resolution. ~4% of diagonal at peak.
  const max_radius_px = viewport_diagonal * 0.04;
  const radius = max_radius_px * (0.18 + 0.82 * eased);
  const opacity = (1 - eased) * 0.9;
  return (
    <div
      style={{
        position: "absolute",
        left: `${x_pct}%`,
        top: `${y_pct}%`,
        width: radius * 2,
        height: radius * 2,
        // Center the halo on the click point.
        transform: "translate(-50%, -50%)",
        borderRadius: "50%",
        border: `${Math.max(2, viewport_diagonal * 0.002)}px solid ${color}`,
        opacity,
        boxShadow: `0 0 ${20 * eased}px ${color}`,
        pointerEvents: "none",
      }}
    />
  );
};

const DottedCircle: React.FC<HighlightStyleProps> = ({ t, x_pct, y_pct, viewport_diagonal, color }) => {
  const eased = applyEase("expo_out", t);
  const max_radius_px = viewport_diagonal * 0.035;
  const radius = max_radius_px * (0.3 + 0.7 * eased);
  const rot = t * 240;
  const opacity = 1 - applyEase("quad_in", Math.max(0, t - 0.6) / 0.4);
  return (
    <div
      style={{
        position: "absolute",
        left: `${x_pct}%`,
        top: `${y_pct}%`,
        width: radius * 2,
        height: radius * 2,
        transform: `translate(-50%, -50%) rotate(${rot}deg)`,
        borderRadius: "50%",
        border: `${Math.max(2, viewport_diagonal * 0.0017)}px dashed ${color}`,
        opacity,
        pointerEvents: "none",
      }}
    />
  );
};

const ArrowCallout: React.FC<HighlightStyleProps> = ({ t, x_pct, y_pct, viewport_diagonal, color }) => {
  const eased = applyEase("back_out", t);
  const offset = (1 - eased) * 24;
  const sz = viewport_diagonal * 0.04;
  const opacity =
    applyEase("cubic_out", Math.min(1, t * 1.4)) *
    (1 - applyEase("quad_in", Math.max(0, t - 0.6) / 0.4));
  return (
    <svg
      width={sz}
      height={sz}
      viewBox="0 0 48 48"
      style={{
        position: "absolute",
        left: `${x_pct}%`,
        top: `${y_pct}%`,
        // Anchor the arrow tip near the click point with a small offset.
        transform: `translate(${offset}px, ${offset}px)`,
        opacity,
        pointerEvents: "none",
        filter: `drop-shadow(0 2px 6px rgba(0,0,0,0.35))`,
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
