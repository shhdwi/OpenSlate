/**
 * Step badges flourish — small numeric "1 / 2 / 3" badges in the corner
 * indicating walkthrough progress. Active for the duration of each beat.
 *
 * principle 9 (secondary animation): badge scales/fades on entry/exit
 * principle 10 (appeal): only enabled in walkthroughs with 3+ steps
 */

import React from "react";
import type { FlourishStepBadges } from "../core/types.js";
import { applyEase } from "../utils/easings.js";
import type { FlourishContext } from "./types.js";

const ENTRY_MS = 280;
const EXIT_MS = 220;

export interface StepBadgesProps {
  config: FlourishStepBadges;
  ctx: FlourishContext;
}

export const StepBadges: React.FC<StepBadgesProps> = ({ config, ctx }) => {
  if (config.enabled_on === "off") return null;
  if (config.enabled_on === "walkthrough_only") {
    // We approximate "walkthrough" as: any recording with ≥3 click events.
    const clickCount = ctx.events.filter((e) => e.kind === "click").length;
    if (clickCount < 3) return null;
  }

  const interactiveKinds = new Set(["click", "type", "scroll", "hover"]);
  const beats = ctx.events
    .filter((e) => interactiveKinds.has(e.kind) && typeof e.step_index === "number")
    .filter((e, i, arr) => i === arr.findIndex((x) => x.step_index === e.step_index));

  // Find the active beat for this t_ms — last beat whose t_ms ≤ ctx.t_ms,
  // valid until the next one starts (or 2.5s after if last).
  let activeIdx = -1;
  let activeStart = 0;
  let activeEnd = 0;
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const next = beats[i + 1];
    if (!b) continue;
    const start = b.t_ms;
    const end = next ? next.t_ms : b.t_ms + 2500;
    if (ctx.t_ms >= start && ctx.t_ms <= end) {
      activeIdx = i;
      activeStart = start;
      activeEnd = end;
      break;
    }
  }

  if (activeIdx < 0) return null;

  // Entry/exit progress.
  const entryProgress = Math.min(1, (ctx.t_ms - activeStart) / ENTRY_MS);
  const exitWindowStart = activeEnd - EXIT_MS;
  const exitProgress =
    ctx.t_ms > exitWindowStart ? Math.min(1, (ctx.t_ms - exitWindowStart) / EXIT_MS) : 0;
  const opacity = applyEase("cubic_out", entryProgress) * (1 - applyEase("cubic_in", exitProgress));
  const scale = 0.85 + 0.15 * applyEase("back_out", entryProgress);

  const total = beats.length;
  const num = activeIdx + 1;

  const positionStyle = positionToCss(config.position);

  if (config.style === "minimal_chip") {
    return (
      <div
        style={{
          position: "absolute",
          ...positionStyle,
          opacity,
          transform: `scale(${scale})`,
          padding: "8px 14px",
          borderRadius: 999,
          background: hexA(ctx.brand.neutral_dark, 0.85),
          color: ctx.brand.neutral_light,
          fontFamily: ctx.brand.font,
          fontSize: 16,
          fontWeight: 600,
          letterSpacing: 0.4,
          backdropFilter: "blur(6px)",
          pointerEvents: "none",
        }}
      >
        {num} / {total}
      </div>
    );
  }

  // circular_numeric: solid colored ring with number inside
  const sz = 52;
  return (
    <div
      style={{
        position: "absolute",
        ...positionStyle,
        opacity,
        transform: `scale(${scale})`,
        width: sz,
        height: sz,
        borderRadius: "50%",
        background: ctx.brand.primary,
        color: ctx.brand.neutral_light,
        fontFamily: ctx.brand.font,
        fontSize: 22,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: `0 4px 14px ${hexA(ctx.brand.primary, 0.45)}`,
        pointerEvents: "none",
      }}
    >
      {num}
    </div>
  );
};

function positionToCss(position: FlourishStepBadges["position"]): React.CSSProperties {
  const inset = 32;
  switch (position) {
    case "top_left":
      return { top: inset, left: inset };
    case "top_right":
      return { top: inset, right: inset };
    case "bottom_left":
      return { bottom: inset, left: inset };
    case "bottom_right":
      return { bottom: inset, right: inset };
  }
}

function hexA(hex: string, a: number): string {
  const m = /^#([\da-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return `rgba(0,0,0,${a})`;
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
