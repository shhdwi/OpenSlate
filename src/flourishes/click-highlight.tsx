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
}

export const ClickHighlight: React.FC<ClickHighlightProps> = ({ config, ctx }) => {
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

  return (
    <>
      {candidates.map((e, idx) => {
        const local_t = Math.max(0, Math.min(1, (ctx.t_ms - e.t_ms) / config.duration_ms));
        return (
          <HighlightForStyle
            key={`hl-${idx}`}
            style={config.style}
            t={local_t}
            x={e.x ?? 0}
            y={e.y ?? 0}
            color={color}
          />
        );
      })}
    </>
  );
};

const HighlightForStyle: React.FC<{
  style: FlourishClickHighlight["style"];
  t: number;
  x: number;
  y: number;
  color: string;
}> = ({ style, t, x, y, color }) => {
  switch (style) {
    case "halo_pulse":
      return <HaloPulse t={t} x={x} y={y} color={color} />;
    case "dotted_circle":
      return <DottedCircle t={t} x={x} y={y} color={color} />;
    case "arrow_callout":
      return <ArrowCallout t={t} x={x} y={y} color={color} />;
  }
};

const HaloPulse: React.FC<{ t: number; x: number; y: number; color: string }> = ({
  t,
  x,
  y,
  color,
}) => {
  const eased = applyEase("cubic_out", t);
  const radius = 12 + 56 * eased;
  const opacity = (1 - eased) * 0.85;
  return (
    <div
      style={{
        position: "absolute",
        left: x - radius,
        top: y - radius,
        width: radius * 2,
        height: radius * 2,
        borderRadius: "50%",
        border: `3px solid ${color}`,
        opacity,
        boxShadow: `0 0 ${24 * eased}px ${color}`,
        pointerEvents: "none",
      }}
    />
  );
};

const DottedCircle: React.FC<{ t: number; x: number; y: number; color: string }> = ({
  t,
  x,
  y,
  color,
}) => {
  const eased = applyEase("expo_out", t);
  const radius = 14 + 42 * eased;
  const rot = t * 240;
  const opacity = 1 - applyEase("quad_in", Math.max(0, t - 0.6) / 0.4);
  return (
    <div
      style={{
        position: "absolute",
        left: x - radius,
        top: y - radius,
        width: radius * 2,
        height: radius * 2,
        borderRadius: "50%",
        border: `2.5px dashed ${color}`,
        transform: `rotate(${rot}deg)`,
        opacity,
        pointerEvents: "none",
      }}
    />
  );
};

const ArrowCallout: React.FC<{ t: number; x: number; y: number; color: string }> = ({
  t,
  x,
  y,
  color,
}) => {
  const eased = applyEase("back_out", t);
  const offset = (1 - eased) * 24;
  const opacity = applyEase("cubic_out", Math.min(1, t * 1.4)) * (1 - applyEase("quad_in", Math.max(0, t - 0.6) / 0.4));
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      style={{
        position: "absolute",
        left: x + 16 + offset,
        top: y + 16 + offset,
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
