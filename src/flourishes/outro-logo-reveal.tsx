/**
 * Outro logo reveal. Three styles supported in v1:
 *   - wordmark_lift  — text rises into place with back_out
 *   - wordmark_blur_in — text fades from blurred to crisp
 *   - symbol_orbit   — a logo glyph orbits to position
 *
 * principle 2 (easings): named eases per style
 * principle 3 (mass_and_weight): logo is grounded with a subtle drop shadow
 * principle 8 (exaggeration): emphatic but brief (≤1.2s)
 */

import React from "react";
import type { FlourishOutroLogoReveal } from "../core/types.js";
import { applyEase } from "../utils/easings.js";
import type { FlourishContext } from "./types.js";

export interface OutroLogoRevealProps {
  config: FlourishOutroLogoReveal;
  ctx: FlourishContext;
}

export const OutroLogoReveal: React.FC<OutroLogoRevealProps> = ({ config, ctx }) => {
  // Trigger window: last config.duration_ms of the recording.
  const start = ctx.total_duration_ms - config.duration_ms;
  if (ctx.t_ms < start) return null;

  const local_t = Math.max(0, Math.min(1, (ctx.t_ms - start) / config.duration_ms));

  // v1: text wordmark sources from a few possible places, in priority order.
  // v1.5 will support rendering the SVG/PNG logo from `brand.logo` directly.
  // If none is available, skip the wordmark variants entirely (don't render
  // the font name — that was a bug that surfaced as "Inter" on default
  // configs without a brand wordmark).
  const wordmark = pickWordmark(ctx);

  switch (config.style) {
    case "wordmark_lift":
      if (!wordmark) return null;
      return <WordmarkLift t={local_t} brand={ctx.brand} text={wordmark} />;
    case "wordmark_blur_in":
      if (!wordmark) return null;
      return <WordmarkBlurIn t={local_t} brand={ctx.brand} text={wordmark} />;
    case "symbol_orbit":
      return <SymbolOrbit t={local_t} brand={ctx.brand} />;
  }
};

function pickWordmark(ctx: FlourishContext): string | null {
  // Future: parse brand.logo as inline SVG path, render at scale.
  // For now the wordmark text comes from an explicit brand.name field if
  // the project sets one; falls back to null (skip rendering).
  const brand = ctx.brand as typeof ctx.brand & { name?: string };
  if (typeof brand.name === "string" && brand.name.length > 0) return brand.name;
  return null;
}

const WordmarkLift: React.FC<{ t: number; brand: FlourishContext["brand"]; text: string }> = ({
  t,
  brand,
  text,
}) => {
  const eased = applyEase("back_out", t);
  const opacity = applyEase("cubic_out", Math.min(1, t * 1.5));
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontFamily: brand.font,
          fontWeight: 700,
          fontSize: 64,
          color: brand.neutral_light,
          letterSpacing: -1.2,
          opacity,
          transform: `translateY(${(1 - eased) * 24}px)`,
          textShadow: "0 4px 18px rgba(0,0,0,0.35)",
        }}
      >
        {text}
      </div>
    </div>
  );
};

const WordmarkBlurIn: React.FC<{ t: number; brand: FlourishContext["brand"]; text: string }> = ({
  t,
  brand,
  text,
}) => {
  const eased = applyEase("expo_out", t);
  const blur = (1 - eased) * 18;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontFamily: brand.font,
          fontWeight: 600,
          fontSize: 60,
          color: brand.neutral_light,
          letterSpacing: -1.2,
          opacity: eased,
          filter: `blur(${blur}px)`,
        }}
      >
        {text}
      </div>
    </div>
  );
};

const SymbolOrbit: React.FC<{ t: number; brand: FlourishContext["brand"] }> = ({ t, brand }) => {
  const eased = applyEase("quart_out", t);
  // Simple orbit: dot rotates ~270° while scaling in.
  const angle = (1 - eased) * 270;
  const scale = 0.4 + 0.6 * eased;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: "50%",
          border: `2px solid ${brand.accent}`,
          transform: `rotate(${angle}deg) scale(${scale})`,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -6,
            left: "50%",
            transform: "translateX(-50%)",
            width: 14,
            height: 14,
            borderRadius: 7,
            background: brand.accent,
            boxShadow: `0 0 16px ${brand.accent}`,
          }}
        />
      </div>
    </div>
  );
};
