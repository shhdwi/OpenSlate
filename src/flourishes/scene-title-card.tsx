/**
 * Scene title card flourish — a brief title slides into view at scene
 * boundaries, then fades. Useful in walkthroughs where each beat is a
 * distinct "scene" (e.g., "Step 1: Connect your account").
 *
 * v1: triggers on the first interactive event of each step that has a
 *   `note` and renders the note as the title for that step's window.
 *
 * principle 4 (anticipation): title appears slightly before the action
 * principle 9 (secondary animation): backdrop subtly slides in opposite
 *   direction of the title text
 * principle 10 (appeal): default off; opt-in for walkthroughs
 */

import React from "react";
import type { FlourishSceneTitleCard } from "../core/types.js";
import { applyEase } from "../utils/easings.js";
import type { FlourishContext } from "./types.js";

const LEAD_MS = 200;

export interface SceneTitleCardProps {
  config: FlourishSceneTitleCard;
  ctx: FlourishContext;
}

export const SceneTitleCard: React.FC<SceneTitleCardProps> = ({ config, ctx }) => {
  if (config.enabled_on === "off" || config.style === "off") return null;
  if (config.enabled_on === "walkthrough_only") {
    const clickCount = ctx.events.filter((e) => e.kind === "click").length;
    if (clickCount < 3) return null;
  }

  // Find the active title window: most recent step-bearing event with a note.
  const interactiveKinds = new Set(["click", "type", "scroll", "hover"]);
  let activeText = "";
  let activeStart = 0;
  for (const e of ctx.events) {
    if (!interactiveKinds.has(e.kind)) continue;
    const note = (e.note ?? "").trim();
    if (!note) continue;
    const window_start = Math.max(0, e.t_ms - LEAD_MS);
    const window_end = window_start + config.duration_ms;
    if (ctx.t_ms >= window_start && ctx.t_ms <= window_end) {
      activeText = note;
      activeStart = window_start;
    }
  }
  if (!activeText) return null;

  const local_t = (ctx.t_ms - activeStart) / config.duration_ms;
  // Three phases: entry (0-25%), hold (25-75%), exit (75-100%).
  const entry = applyEase("quart_out", Math.max(0, Math.min(1, local_t / 0.25)));
  const exit = applyEase("cubic_in", Math.max(0, Math.min(1, (local_t - 0.75) / 0.25)));
  const opacity = entry * (1 - exit);

  if (config.style === "lower_third_reveal") {
    const slideX = (1 - entry) * -32; // slide in from left
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: "13%",
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
          opacity,
        }}
      >
        <div
          style={{
            padding: "12px 24px",
            borderRadius: 8,
            background: hexA(ctx.brand.neutral_dark, 0.9),
            color: ctx.brand.neutral_light,
            fontFamily: ctx.brand.font,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: 0.2,
            transform: `translateX(${slideX}px)`,
            backdropFilter: "blur(8px)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            // accent stripe on the leading edge
            borderLeft: `3px solid ${ctx.brand.accent}`,
          }}
        >
          {activeText}
        </div>
      </div>
    );
  }

  // centered_fade
  const scale = 0.94 + 0.06 * entry;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        opacity,
      }}
    >
      <div
        style={{
          padding: "16px 32px",
          fontFamily: ctx.brand.font,
          fontSize: 36,
          fontWeight: 700,
          color: ctx.brand.neutral_light,
          textShadow: "0 4px 18px rgba(0,0,0,0.4)",
          transform: `scale(${scale})`,
        }}
      >
        {activeText}
      </div>
    </div>
  );
};

function hexA(hex: string, a: number): string {
  const m = /^#([\da-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return `rgba(0,0,0,${a})`;
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
