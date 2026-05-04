/**
 * Success burst flourish — confetti / checkmark / ring pulse celebration
 * for moments of accomplishment. Manual-trigger only by default; the agent
 * opts in via per-event flag (events with `is_protagonist: true` AND
 * a `note` containing /success|done|complete|saved/i).
 *
 * principle 8 (exaggeration): bursts are emphatic by design (this is the
 *   one place restraint takes a back seat — it's a celebration moment)
 * principle 6 (squash & stretch): checkmark scales in with overshoot
 * principle 9 (secondary animation): ring pulses in counter to particles
 */

import React from "react";
import type { FlourishSuccessBurst } from "../core/types.js";
import { applyEase } from "../utils/easings.js";
import type { FlourishContext } from "./types.js";

const BURST_DURATION_MS = 1400;

export interface SuccessBurstProps {
  config: FlourishSuccessBurst;
  ctx: FlourishContext;
}

export const SuccessBurst: React.FC<SuccessBurstProps> = ({ config, ctx }) => {
  if (config.enabled_on === "off") return null;

  // Find a triggering event: protagonist click with a "success-y" note,
  // OR any event explicitly marked is_protagonist with note matching.
  const triggers = ctx.events.filter((e) => {
    if (e.kind !== "click") return false;
    if (!e.is_protagonist) return false;
    const note = (e.note ?? "").toLowerCase();
    return /success|done|complete|saved|finish|submit|created/.test(note);
  });

  if (triggers.length === 0) return null;

  const color = resolveColor(config.color, ctx);

  return (
    <>
      {triggers.map((trigger, idx) => {
        if (ctx.t_ms < trigger.t_ms || ctx.t_ms > trigger.t_ms + BURST_DURATION_MS) return null;
        const local_t = (ctx.t_ms - trigger.t_ms) / BURST_DURATION_MS;
        const cx = trigger.x ?? ctx.events[0]?.x ?? 0;
        const cy = trigger.y ?? ctx.events[0]?.y ?? 0;
        return (
          <BurstForStyle
            key={`burst-${idx}`}
            style={config.style}
            t={local_t}
            cx={cx}
            cy={cy}
            color={color}
          />
        );
      })}
    </>
  );
};

const BurstForStyle: React.FC<{
  style: FlourishSuccessBurst["style"];
  t: number;
  cx: number;
  cy: number;
  color: string;
}> = ({ style, t, cx, cy, color }) => {
  switch (style) {
    case "confetti_minimal":
      return <ConfettiMinimal t={t} cx={cx} cy={cy} color={color} />;
    case "checkmark_pop":
      return <CheckmarkPop t={t} cx={cx} cy={cy} color={color} />;
    case "ring_pulse":
      return <RingPulse t={t} cx={cx} cy={cy} color={color} />;
  }
};

/** 12 particles burst outward in a fan; 90° spread by default upward. */
const ConfettiMinimal: React.FC<{ t: number; cx: number; cy: number; color: string }> = ({
  t,
  cx,
  cy,
  color,
}) => {
  const eased = applyEase("expo_out", t);
  const particles = 12;
  const max_radius = 140;
  return (
    <>
      {Array.from({ length: particles }).map((_, i) => {
        // Spread across a 270° arc (mostly upward, sides) — leaves bottom clear.
        const angle = (-Math.PI * 0.85) + (i / (particles - 1)) * Math.PI * 1.7;
        const r = max_radius * eased;
        const px = cx + Math.cos(angle) * r;
        const py = cy + Math.sin(angle) * r * 0.8 + 60 * t * t; // slight gravity drop
        const opacity = 1 - applyEase("quad_in", Math.max(0, t - 0.5) / 0.5);
        const rot = i * 30 + t * 360;
        const idxColor = i % 3 === 0 ? color : i % 3 === 1 ? "#ffffff" : `${color}cc`;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: px,
              top: py,
              width: 8,
              height: 14,
              transform: `translate(-50%, -50%) rotate(${rot}deg)`,
              background: idxColor,
              borderRadius: 1,
              opacity,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </>
  );
};

const CheckmarkPop: React.FC<{ t: number; cx: number; cy: number; color: string }> = ({
  t,
  cx,
  cy,
  color,
}) => {
  // Two phases: ring scale-in (0-0.4), checkmark draw (0.4-0.8), settle hold (0.8-1.0)
  const ringPhase = Math.min(1, t / 0.4);
  const drawPhase = Math.max(0, Math.min(1, (t - 0.4) / 0.4));
  const ringScale = applyEase("back_out", ringPhase);
  const ringOpacity = ringPhase * (1 - applyEase("quad_in", Math.max(0, t - 0.85) / 0.15));
  const drawProgress = applyEase("cubic_out", drawPhase);

  const sz = 96;
  return (
    <div
      style={{
        position: "absolute",
        left: cx - sz / 2,
        top: cy - sz / 2,
        width: sz,
        height: sz,
        opacity: ringOpacity,
        transform: `scale(${ringScale})`,
        pointerEvents: "none",
      }}
    >
      {/* Ring */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 32px ${color}`,
        }}
      />
      {/* Checkmark — drawn via SVG stroke-dashoffset */}
      <svg
        viewBox="0 0 100 100"
        width={sz}
        height={sz}
        style={{ position: "absolute", inset: 0 }}
      >
        <path
          d="M28 52 L44 68 L74 36"
          fill="none"
          stroke="white"
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={80}
          strokeDashoffset={80 * (1 - drawProgress)}
        />
      </svg>
    </div>
  );
};

const RingPulse: React.FC<{ t: number; cx: number; cy: number; color: string }> = ({
  t,
  cx,
  cy,
  color,
}) => {
  // Two concentric rings expanding at offset phases.
  return (
    <>
      {[0, 0.18].map((delay, i) => {
        const local_t = Math.max(0, Math.min(1, (t - delay) / (1 - delay)));
        if (local_t <= 0) return null;
        const eased = applyEase("expo_out", local_t);
        const radius = 24 + 100 * eased;
        const opacity = (1 - eased) * 0.85;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: cx - radius,
              top: cy - radius,
              width: radius * 2,
              height: radius * 2,
              borderRadius: "50%",
              border: `3px solid ${color}`,
              opacity,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </>
  );
};

function resolveColor(c: string, ctx: FlourishContext): string {
  if (c === "brand.primary") return ctx.brand.primary;
  if (c === "brand.accent") return ctx.brand.accent;
  if (c === "brand.neutral_dark") return ctx.brand.neutral_dark;
  if (c === "brand.neutral_light") return ctx.brand.neutral_light;
  return c;
}
